import { HUSK_PROTOCOL, HUSK_VERSION } from '@husk-ai/core';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { assertBindIsSafe, fromPublic, installAuth, isLoopbackHost } from './auth.js';
import { installBodyParsers } from './body.js';
import { installConsole } from './console.js';
import { createContext } from './context.js';
import type { ServerContext } from './context.js';
import { resolveDeps } from './deps.js';
import type { ServerDeps } from './deps.js';
import { huskError, installErrorHandling } from './errors.js';
import { proxyTriggers } from './jobs.js';
import type { JobsLink } from './jobs.js';
import { approvalRoutes } from './routes/approvals.js';
import { actorOf, handoffRoutes, refuseIfHeld } from './routes/handoffs.js';
import { archiveRoutes } from './routes/archive.js';
import { browserRoutes } from './routes/browser.js';
import { computerRoutes } from './routes/computers.js';
import { doctorRoutes } from './routes/doctor.js';
import { eventRoutes } from './routes/events.js';
import { huskRoutes, huskValidateRoute } from './routes/husks.js';
import { modelRoutes } from './routes/models.js';
import { runRoutes } from './routes/runs.js';
import { sessionRoutes } from './routes/sessions.js';
import { createTriggerHost } from './triggers/index.js';
import { toolRoutes } from './routes/tools.js';
import { setupRoutes } from './routes/setup.js';
import { isRemotePath } from './remote/oauth.js';
import type { Remote } from './remote/oauth.js';
import { remoteRoutes } from './remote/routes.js';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

export interface CreateAppOptions extends ServerDeps {
  /** Skip the loopback-without-a-token check. Only tests should set this. */
  unsafeAllowAnyBind?: boolean;
  approvalTimeoutMs?: number;
  workspaceStore?: WorkspaceStore;
  /**
   * The job host's link (jobs.ts): with it, this app mounts no trigger, forwards
   * the trigger routes to the job host and starts it when a bot has one.
   */
  jobs?: JobsLink;
  /** Remote access, started: its OAuth server and `/mcp` under the public URL. */
  remote?: Remote;
}

/**
 * Build the Fastify instance.
 *
 * Everything the app touches arrives through `deps`, so a test drives every route
 * with `app.inject()` against fake providers -- no Docker, no WSL, no network, no
 * listening socket.
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const deps = resolveDeps(options);
  const { config, log } = deps;

  if (!options.unsafeAllowAnyBind) assertBindIsSafe(config.host, config.token);
  await deps.store.init();

  const app = Fastify({
    logger: false,
    bodyLimit: config.bodyLimitBytes ?? 32 * 1024 * 1024,
    // Trusting X-Forwarded-For by default would let anyone spoof their address in
    // our logs. A reverse proxy is not the expected deployment for a local daemon.
    trustProxy: false,
  });

  const ctx: ServerContext = createContext(
    deps,
    options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs },
  );
  if (options.remote) ctx.remote = options.remote;
  app.decorate('husk', ctx);

  installErrorHandling(app);

  if (config.corsOrigins !== false) {
    const cors = (await import('@fastify/cors')).default;
    await app.register(cors, {
      origin: config.corsOrigins === true ? true : (config.corsOrigins ?? false),
      credentials: false,
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Husk-Signature', 'X-Husk-As'],
      exposedHeaders: ['X-Husk-Version'],
    });
  }

  const websocket = (await import('@fastify/websocket')).default;
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  const remote = options.remote;
  installAuth(app, {
    token: config.token,
    publicPrefixes: ['/assets/', '/favicon', '/v1/a/'],
    scopeOf: (t, o) => ctx.scoped.verify(t, o),
    loopbackOnly: isLoopbackHost(config.host),
    ...(remote
      ? { remote: { mark: remote.mark, origin: remote.origin, paths: isRemotePath, on: () => remote.offReason === undefined, owner: (s) => remote.ownerSession(s) } }
      : {}),
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    void reply.header('X-Husk-Version', HUSK_VERSION);
    return payload;
  });

  installBodyParsers(app);
  installIdempotency(app, remote?.mark);
  installAdmission(app);
  // A link under the public URL stops opening when remote access goes off or resets, or its app signs out.
  remote?.onRevoke((client) => ctx.scoped.revokePublic(client));

  // Under the public URL it says only that it is up: a version is for this machine.
  app.get('/health', async (req) =>
    remote && fromPublic(req, remote.mark)
      ? { ok: true }
      : { ok: true, version: HUSK_VERSION, protocol: HUSK_PROTOCOL, uptimeSec: Math.round((deps.now() - deps.startedAt) / 1000) },
  );

  await app.register(doctorRoutes);
  await app.register(computerRoutes);
  await app.register(archiveRoutes);
  await app.register(browserRoutes);
  // Registered before the resource routes so `/v1/husks/validate` is matched before
  // `/v1/husks/:name` would swallow it.
  await app.register(huskValidateRoute);
  await app.register(huskRoutes);
  await app.register(runRoutes);
  await app.register(sessionRoutes);
  await app.register(modelRoutes);
  await app.register(approvalRoutes);
  await app.register(handoffRoutes);
  await app.register(toolRoutes);
  await app.register(setupRoutes);
  if (remote) await app.register(async (scope) => remoteRoutes(scope, remote, deps.remoteMcp));

  // A newer Husk asks an older one to step aside, and the desktop app's "Quit
  // and stop Husk" uses it. Only when nobody is mid-run or mid-handoff: an
  // upgrade must not cut off a person signing in.
  app.post('/v1/shutdown', async (_req, reply) => {
    if (!ctx.shutdown) throw huskError('E_NOT_IMPLEMENTED', 'this server cannot stop itself');
    const busy = ctx.runner.listActive().length + ctx.runner.handoffs.list().length;
    if (busy) {
      throw huskError('E_EXEC_DENIED', `not stopping: ${busy} run(s) or handoff(s) are in progress`, {
        hint: 'try again when they finish',
      });
    }
    setTimeout(() => void ctx.shutdown?.(), 50).unref();
    return reply.code(202).send({ stopping: true });
  });
  await app.register(eventRoutes);
  await registerWorkspaceRoutes(app, options.workspaceStore);

  if (options.jobs) {
    ctx.triggers = options.jobs;
    proxyTriggers(app, options.jobs);
  } else if (config.triggers !== false) {
    const host = createTriggerHost(app);
    await host.sync();
    host.start();
    log.debug(`mounted ${host.list().length} trigger(s)`);
  }

  // Last: it installs the SPA fallback not-found handler, which must not shadow
  // any API route registered above.
  const consoleDir = await installConsole(app, config.consoleDir);
  if (consoleDir) log.debug(`serving console from ${consoleDir}`);

  await app.ready();
  return app;
}

/**
 * Routes under /v1/computers/:id that change nothing, or keep a rule of their own.
 * Every other route there that changes a computer goes through the admission below.
 */
export const ADMISSION_EXEMPT: ReadonlySet<string> = new Set([
  // Waits for the person to give the computer back, then runs under its control.
  'POST /v1/computers/:id/tools/:name',
  // The person taking it, a chat asking for them, a link to look: none acts on the computer.
  'POST /v1/computers/:id/takeover',
  'POST /v1/computers/:id/handoffs',
  'POST /v1/computers/:id/link',
  // A chat telling this Husk it runs that computer itself: a note, not a change.
  'POST /v1/computers/:id/in-chat',
  // Reads.
  'POST /v1/computers/:id/browser/snapshot',
  'POST /v1/computers/:id/bot',
]);

const CHANGES_A_COMPUTER = /^(POST|PUT|PATCH|DELETE) \/v1\/computers\/:id(\/|$)/;

/**
 * Take-over, on every route that changes a computer: while a person holds it,
 * a program's change is refused here, in one place. The console's own buttons
 * act as the person (`X-Husk-As: person`) and go through. Cooperation, not a
 * boundary: a program that sends the header is believed.
 */
function installAdmission(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    const route = `${req.method} ${req.routeOptions.url ?? ''}`;
    if (!CHANGES_A_COMPUTER.test(route) || ADMISSION_EXEMPT.has(route)) return;
    const { id } = req.params as { id?: string };
    if (id) refuseIfHeld(app.husk.runner.handoffs, id, actorOf(req));
  });
}

/**
 * `Idempotency-Key` on mutating requests.
 *
 * The retry that matters is the one after a timeout, where the client cannot tell
 * whether the first attempt created a computer. Replaying the recorded response is
 * the difference between one machine and eight.
 *
 * Never under remote access's public URL (`publicMark`): there a stranger could
 * fill the cache, skip a handler's own limits by replaying, or read back an
 * answer someone else's key recorded, such as their tokens.
 */
function installIdempotency(app: FastifyInstance, publicMark?: string): void {
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !MUTATING.has(req.method) || fromPublic(req, publicMark)) return;
    const scoped = `${req.method} ${req.url} ${key}`;
    const hit = app.husk.deps.store.recallIdempotent(scoped);
    if (hit) {
      // Returning the reply is what actually short-circuits the lifecycle. Calling
      // `send` alone lets the handler run too, which is the bug this hook exists
      // to prevent.
      await reply.header('Idempotency-Replayed', 'true').code(hit.status).send(hit.body);
      return reply;
    }
    return undefined;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !MUTATING.has(req.method) || fromPublic(req, publicMark)) return payload;
    if (reply.getHeader('Idempotency-Replayed')) return payload;
    if (reply.statusCode >= 400) return payload;
    const scoped = `${req.method} ${req.url} ${key}`;
    let body: unknown = payload;
    if (typeof payload === 'string') {
      try {
        body = JSON.parse(payload);
      } catch {
        body = payload;
      }
    }
    app.husk.deps.store.rememberIdempotent(scoped, reply.statusCode, body);
    return payload;
  });
}
