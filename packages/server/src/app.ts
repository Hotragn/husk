import { HUSK_VERSION } from '@husk-ai/core';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { assertBindIsSafe, installAuth } from './auth.js';
import { installConsole } from './console.js';
import { createContext } from './context.js';
import type { ServerContext } from './context.js';
import { resolveDeps } from './deps.js';
import type { ServerDeps } from './deps.js';
import { installErrorHandling } from './errors.js';
import { approvalRoutes } from './routes/approvals.js';
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

export interface CreateAppOptions extends ServerDeps {
  /** Skip the loopback-without-a-token check. Only tests should set this. */
  unsafeAllowAnyBind?: boolean;
  approvalTimeoutMs?: number;
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
  app.decorate('husk', ctx);

  installErrorHandling(app);

  if (config.corsOrigins !== false) {
    const cors = (await import('@fastify/cors')).default;
    await app.register(cors, {
      origin: config.corsOrigins === true ? true : (config.corsOrigins ?? false),
      credentials: false,
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Husk-Signature'],
      exposedHeaders: ['X-Husk-Version'],
    });
  }

  const websocket = (await import('@fastify/websocket')).default;
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  installAuth(app, { token: config.token, publicPrefixes: ['/assets/', '/favicon'] });

  app.addHook('onSend', async (_req, reply, payload) => {
    void reply.header('X-Husk-Version', HUSK_VERSION);
    return payload;
  });

  installBodyParsers(app);
  installIdempotency(app);

  app.get('/health', async () => ({
    ok: true,
    version: HUSK_VERSION,
    uptimeSec: Math.round((deps.now() - deps.startedAt) / 1000),
  }));

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
  await app.register(eventRoutes);

  if (config.triggers !== false) {
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
 * Raw body capture plus the parsers the API needs.
 *
 * Webhook signatures are computed over the exact bytes received. Re-serialising a
 * parsed object changes key order and whitespace, and then every signature fails
 * for a reason that is invisible in a log.
 */
function installBodyParsers(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done: (err: Error | null, value?: unknown) => void) => {
      req.rawBody = body;
      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e);
      }
    },
  );

  app.addContentTypeParser(
    ['text/plain', 'application/x-www-form-urlencoded'],
    { parseAs: 'string' },
    (req, body: string, done: (err: Error | null, value?: unknown) => void) => {
      req.rawBody = Buffer.from(body, 'utf8');
      done(null, body);
    },
  );

  // Everything else -- file writes, tarballs, unknown webhook payloads -- stays bytes.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer' },
    (req, body: Buffer, done: (err: Error | null, value?: unknown) => void) => {
      req.rawBody = body;
      done(null, body);
    },
  );
}

/**
 * `Idempotency-Key` on mutating requests.
 *
 * The retry that matters is the one after a timeout, where the client cannot tell
 * whether the first attempt created a computer. Replaying the recorded response is
 * the difference between one machine and eight.
 */
function installIdempotency(app: FastifyInstance): void {
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !MUTATING.has(req.method)) return;
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
    if (typeof key !== 'string' || !MUTATING.has(req.method)) return payload;
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
