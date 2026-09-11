import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ComputerSpec, Logger } from '@husk/core';
import { ctxOf } from '../context.js';
import { huskError, sendError } from '../errors.js';
import {
  assertMcpBindIsSafe,
  assertProviderMayServeRemote,
  sessionKeyForRequest,
} from '../mcp-session.js';
import type { SessionIdentity } from '../mcp-session.js';

/**
 * `POST|GET|DELETE /mcp` -- husk as a remote MCP server.
 *
 * The tool surface already worked: `computer_info` returns a real Linux box,
 * `/work` survives across separate tool calls, and `browse` genuinely runs
 * inside the computer. What did not exist was a way for a chat surface that
 * cannot spawn a subprocess to reach it -- `chatgpt.com`, `kimi`, `claude.ai`
 * in a browser all need a URL, and `@husk/mcp` only spoke stdio.
 *
 * So this adds a transport and nothing else. `TOOLS` and `callTool` are mounted
 * exactly as the stdio server mounts them, auth is the control plane's existing
 * `installAuth` hook rather than a second scheme, and `husk mcp` is untouched:
 * local desktop clients are the majority case today and they already work.
 *
 * Two things are enforced here that stdio never had to care about, both because
 * one endpoint now serves many sessions:
 *
 *  - the computer is bound per authenticated session, not per husk name
 *    (`sessionKeyForRequest`), or two people's chats share one `/work`;
 *  - the backing provider must be isolated (`assertProviderMayServeRemote`), or
 *    a remote request drives an unsandboxed shell on the user's own laptop.
 */

/** Path the endpoint is mounted at. Streamable HTTP uses one path for all verbs. */
export const MCP_PATH = '/mcp';

/** An idle session's transport and computer are released after this long. */
const SESSION_IDLE_MS = 30 * 60_000;

interface McpSdk {
  StreamableHTTPServerTransport: new (opts: {
    sessionIdGenerator?: () => string;
    onsessioninitialized?: (id: string) => void | Promise<void>;
    onsessionclosed?: (id: string) => void | Promise<void>;
    enableJsonResponse?: boolean;
  }) => {
    sessionId: string | undefined;
    handleRequest(req: unknown, res: unknown, parsedBody?: unknown): Promise<void>;
    close(): Promise<void>;
    onclose?: (() => void) | undefined;
  };
}

interface HuskMcpModule {
  HuskMcpServer: new (opts: {
    sessionKey?: string;
    spec?: ComputerSpec;
    ephemeral?: boolean;
    manager?: unknown;
    logger?: Logger;
  }) => { server: unknown; close(): Promise<void> };
}

type Transport = InstanceType<McpSdk['StreamableHTTPServerTransport']>;
type HuskMcp = InstanceType<HuskMcpModule['HuskMcpServer']>;

interface Session {
  id: string;
  identity: SessionIdentity;
  transport: Transport;
  husk: HuskMcp;
  lastUsedAt: number;
}

/**
 * Live MCP sessions, keyed by the id the transport minted.
 *
 * Kept on the app rather than in module scope so two `createApp` calls in one
 * test process cannot see each other's sessions.
 */
class SessionRegistry {
  private readonly byId = new Map<string, Session>();
  /** Sessions with no protocol id: one per binding key. See `sessionBindingKey`. */
  private readonly byKey = new Map<string, Session>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly log: Logger) {}

  get size(): number {
    return this.byId.size + this.byKey.size;
  }

  get(id: string): Session | undefined {
    const hit = this.byId.get(id);
    if (hit) hit.lastUsedAt = Date.now();
    return hit;
  }

  getByKey(key: string): Session | undefined {
    const hit = this.byKey.get(key);
    if (hit) hit.lastUsedAt = Date.now();
    return hit;
  }

  /**
   * Register under the protocol session id.
   *
   * Called from `onsessioninitialized`, not at construction: the transport has
   * no `sessionId` until it has handled the initialize request, so registering
   * eagerly filed every session under a placeholder and the client's next
   * request -- which carries the real id -- found nothing.
   */
  addById(id: string, session: Session): void {
    session.id = id;
    this.byId.set(id, session);
    this.startSweeper();
  }

  addByKey(session: Session): void {
    this.byKey.set(session.identity.key, session);
    this.startSweeper();
  }

  async close(session: Session): Promise<void> {
    this.byId.delete(session.id);
    if (this.byKey.get(session.identity.key) === session) this.byKey.delete(session.identity.key);
    // Closing the husk server releases its hold on the binding, which destroys
    // the computer only when no other session is still holding it.
    await session.husk.close().catch((err: unknown) => this.log.debug('mcp session close failed', err));
    await session.transport.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    this.stopSweeper();
    for (const s of [...this.byId.values(), ...this.byKey.values()]) await this.close(s);
  }

  /**
   * Reap sessions nobody came back to.
   *
   * A hosted chat surface does not reliably send `DELETE /mcp` when a
   * conversation ends -- the user just closes the tab. Without this, every
   * abandoned conversation holds a container open indefinitely.
   */
  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - SESSION_IDLE_MS;
      for (const s of [...this.byId.values(), ...this.byKey.values()]) {
        if (s.lastUsedAt < cutoff) {
          this.log.debug(`reaping idle mcp session ${s.id}`);
          void this.close(s);
        }
      }
    }, 60_000);
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}

function isInitialize(body: unknown): boolean {
  const one = (m: unknown): boolean =>
    Boolean(m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize');
  return Array.isArray(body) ? body.some(one) : one(body);
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  const { config, log } = ctx.deps;
  const mcpLog = log.child('mcp-http');

  // Hard-fail rather than mounting something unauthenticated on a public
  // interface. This runs at registration, so `husk serve` refuses to start.
  assertMcpBindIsSafe(config.host, config.token);

  let sdk: McpSdk;
  let mcpModule: HuskMcpModule;
  try {
    sdk = (await import('@modelcontextprotocol/sdk/server/streamableHttp.js')) as unknown as McpSdk;
    mcpModule = (await import('@husk/mcp')) as unknown as HuskMcpModule;
  } catch (err) {
    // Consistent with how the control plane treats every other optional
    // dependency: a half-built sibling costs you this endpoint, not the server.
    mcpLog.error(`the MCP endpoint is unavailable: ${(err as Error).message}`);
    app.all(MCP_PATH, async (_req, reply) =>
      sendError(
        reply,
        huskError('E_NOT_IMPLEMENTED', 'the MCP endpoint could not be loaded', {
          hint: 'run `npm install && npm run build` at the repo root',
        }),
      ),
    );
    return;
  }

  const sessions = new SessionRegistry(mcpLog);
  app.addHook('onClose', async () => {
    await sessions.closeAll();
  });

  /** The spec a remote session's computer is created with. */
  const specForRemote = (): ComputerSpec => ({
    idleTimeoutSec: 3600,
    ...(config.mcpProvider ? { provider: config.mcpProvider } : {}),
  });

  async function createSession(
    identity: SessionIdentity,
    opts: { keyed: boolean; mcpSessionId?: string },
  ): Promise<Session> {
    const spec = specForRemote();

    // Before anything is created. A refusal here is the whole point of §3.3:
    // the endpoint must not come up backed by an unisolated provider, and the
    // check belongs before the first shell command, not after it.
    await assertProviderMayServeRemote(ctx.deps.manager, spec);

    const husk = new mcpModule.HuskMcpServer({
      sessionKey: identity.key,
      spec,
      // The computer is reclaimed when the last holder of this binding key
      // goes away, not when this session does.
      ephemeral: true,
      manager: ctx.deps.manager,
      logger: mcpLog.child(identity.source),
    });

    // Declared before the transport because `onsessioninitialized` fires during
    // the first `handleRequest` and needs to name it.
    let session: Session;

    const transport = new sdk.StreamableHTTPServerTransport({
      // Stateful when the client speaks a revision that has sessions; the
      // keyed path below covers the revision that does not.
      ...(opts.keyed
        ? {}
        : {
            // The id is minted by the caller rather than here, because the
            // binding key is derived from it and the key has to be known before
            // the computer is. Letting the transport generate it meant every
            // initialize looked identical -- no session id yet, no explicit
            // header -- so every chat fell through to the one-per-credential
            // fallback and landed on a shared /work. That is precisely the
            // defect this endpoint exists to avoid.
            sessionIdGenerator: () => opts.mcpSessionId as string,
            onsessioninitialized: (id: string) => {
              sessions.addById(id, session);
              mcpLog.info(`mcp session ${id} (${identity.source}) for principal ${identity.principal}`);
            },
          }),
    });

    // `connect` is on the underlying SDK Server that HuskMcpServer wraps.
    await (husk.server as { connect(t: unknown): Promise<void> }).connect(transport);

    session = { id: identity.key, identity, transport, husk, lastUsedAt: Date.now() };

    transport.onclose = () => {
      void sessions.close(session);
    };

    if (opts.keyed) {
      sessions.addByKey(session);
      mcpLog.info(`mcp session ${identity.key} (${identity.source}) for principal ${identity.principal}`);
    }
    return session;
  }

  /**
   * Hand the raw request and response to the transport.
   *
   * `reply.hijack()` tells Fastify it no longer owns the socket. Without it
   * Fastify would also try to send a reply, and an SSE stream and a JSON body
   * would race for the same response.
   */
  async function dispatch(req: FastifyRequest, reply: FastifyReply, session: Session): Promise<void> {
    reply.hijack();
    // `req.body` is already parsed by the app's JSON content-type parser, so
    // hand it over rather than letting the transport try to read a consumed
    // stream.
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
  }

  app.post(MCP_PATH, async (req, reply) => {
    const headerId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;

    try {
      if (headerId) {
        const existing = sessions.get(headerId);
        if (!existing) {
          // The transport would answer this itself, but only once it owns a
          // session; an unknown id has no transport to answer with.
          return await sendError(
            reply,
            huskError('E_NOT_IMPLEMENTED', 'unknown MCP session', {
              hint: 're-initialize: this server restarted, or the session was reaped after being idle',
            }),
          );
        }
        return await dispatch(req, reply, existing);
      }

      if (isInitialize(req.body)) {
        // Mint the session id here so the binding key can be derived from it.
        const mcpSessionId = randomUUID();
        const identity = sessionKeyForRequest(req, mcpSessionId);
        return await dispatch(req, reply, await createSession(identity, { keyed: false, mcpSessionId }));
      }

      // No session id and not an initialize: either a 2026-07-28 client, which
      // has no protocol sessions at all, or an explicitly pinned workspace.
      // Both get one long-lived session per binding key.
      const identity = sessionKeyForRequest(req);
      const keyed = sessions.getByKey(identity.key) ?? (await createSession(identity, { keyed: true }));
      return await dispatch(req, reply, keyed);
    } catch (err) {
      if (reply.raw.headersSent) {
        mcpLog.error('mcp request failed after the response started', err);
        reply.raw.end();
        return undefined;
      }
      return await sendError(reply, err);
    }
  });

  // The standalone SSE stream for server-initiated notifications, and session
  // teardown. Both require a session the client already has.
  for (const method of ['get', 'delete'] as const) {
    app[method](MCP_PATH, async (req, reply) => {
      const headerId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
      const session = headerId ? sessions.get(headerId) : sessions.getByKey(sessionKeyForRequest(req).key);
      if (!session) {
        return await sendError(
          reply,
          huskError('E_NOT_IMPLEMENTED', 'unknown MCP session', {
            hint: 'send an initialize request first',
          }),
        );
      }
      return await dispatch(req, reply, session);
    });
  }

  /**
   * `GET /mcp/info` -- what to paste into a client, and what this endpoint is.
   *
   * Not part of MCP. It exists because the failure it prevents is the common
   * one: someone points a chat surface at the wrong URL, or at a host with no
   * token, and gets a protocol error with no hint about which of those it was.
   */
  app.get('/mcp/info', async () => ({
    transport: 'streamable-http',
    path: MCP_PATH,
    authRequired: app.huskAuthEnabled,
    activeSessions: sessions.size,
    sessionBinding: {
      header: 'X-Husk-Session',
      query: 'session',
      note:
        'the computer is bound to the authenticated credential plus this session id; ' +
        'omit it and you get one workspace per credential',
    },
  }));

  mcpLog.debug(`mounted the MCP endpoint at ${MCP_PATH}`);
}
