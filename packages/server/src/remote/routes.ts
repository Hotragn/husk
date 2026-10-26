import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PUBLIC_HEADER } from '../auth.js';
import { huskError } from '../errors.js';
import type { Verdict } from './approvals.js';
import type { AccessClaims } from './jwt.js';
import { LIMITS } from './limits.js';
import { accessTokenOf } from './oauth.js';
import type { Remote } from './oauth.js';

/**
 * Serves one MCP request for a signed-in app: Streamable HTTP, both protocol
 * eras, as `@husk-ai/mcp` builds it (`createRemoteMcp`). Handed in, as the
 * chat tools are, because that package sits above this one.
 */
export type RemoteMcp = (request: Request, who: RemoteApp) => Promise<Response>;

/** A signed-in app, as `/mcp` hands it to the MCP side. */
export interface RemoteApp {
  owner: string;
  client: string;
  /** What it registered as, for the computers it makes. */
  name: string;
  /** The public URL: links the app's person opens (a handoff, a look at the computer) are under it. */
  origin: string;
  /**
   * Whether a call that changes things may run now, or the page that asks the
   * owner (approvals.ts): `summary` in a line, `detail` every argument exactly.
   */
  approve: (call: { tool: string; summary: string; detail: string; digest: string }) => Verdict;
}

/** The request as a web-standard one, for the MCP SDK's fetch-shaped handler. It aborts when the app goes away. */
function webRequest(req: FastifyRequest, url: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host' || k === PUBLIC_HEADER || v === undefined) continue;
    for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value);
  }
  const body = req.method === 'POST' ? (req.rawBody ?? (typeof req.body === 'string' ? Buffer.from(req.body) : undefined)) : undefined;
  return new Request(url, { method: req.method, headers, signal, ...(body ? { body: new Uint8Array(body) } : {}) });
}

/** `/mcp` under the public URL, the OAuth server around it, and the owner's controls on this machine. */
export async function remoteRoutes(app: FastifyInstance, remote: Remote, mcp: RemoteMcp | undefined): Promise<void> {
  remote.routes(app);

  const signedIn = new WeakMap<FastifyRequest, AccessClaims>();
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    // The token and the budget first, before a byte of the body is read: a
    // request without a good token costs its headers, not its body.
    onRequest: async (req, reply) => {
      const token = accessTokenOf(req);
      const claims = token ? await remote.verify(token) : undefined;
      // A signed-in app has a budget of its own; requests without a good token share one.
      if (!remote.allow(reply, claims ? [`app:${claims.sub}:${claims.client_id}`, LIMITS.app] : ['mcp', LIMITS.mcp])) return reply;
      if (!claims) return remote.challenge(reply, Boolean(token));
      signedIn.set(req, claims);
      return undefined;
    },
    handler: async (req, reply) => {
      const claims = signedIn.get(req)!;
      if (!mcp) throw huskError('E_NOT_IMPLEMENTED', 'this Husk was started without the chat tools', { hint: 'start it with `husk serve --remote`' });
      const gone = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      const app = { owner: claims.sub, client: claims.client_id, name: remote.appName(claims.client_id), origin: remote.origin };
      const res = await mcp(webRequest(req, remote.resource, gone.signal), {
        ...app,
        approve: (call) => remote.approvals.check({ owner: app.owner, client: app.client, app: app.name, ...call }),
      });
      reply.hijack();
      reply.raw.writeHead(res.status, Object.fromEntries(res.headers));
      if (!res.body) {
        reply.raw.end();
        return reply;
      }
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream).pipe(reply.raw);
      return reply;
    },
  });

  // On this machine, with its token: what `husk remote` and the console show and do.
  app.get('/v1/remote', async () => remote.status());
  app.post('/v1/remote/claim', async () => ({ code: await remote.newClaimCode() }));
  app.post('/v1/remote/reset', async () => ({ code: await remote.reset() }));
  app.post('/v1/remote/off', async () => {
    if (remote.offReason === undefined) await remote.off('Switched off on this machine. Switch it on again to let chat apps back in.');
    return remote.status();
  });
  app.post('/v1/remote/on', async () => {
    await remote.on();
    return remote.status();
  });
  // Signed out whether or not it was in: either way it is not now.
  app.delete('/v1/remote/apps/:id', async (req) => {
    await remote.signOut((req.params as { id: string }).id);
    return remote.status();
  });
}
