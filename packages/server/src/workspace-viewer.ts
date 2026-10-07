import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { HUSK_VERSION } from '@husk-ai/core';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { consoleAssetsPath } from '@husk-ai/console-assets';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

export type WorkspaceProfile = 'starter' | 'computer';
export interface WorkspaceViewerOptions {
  store?: WorkspaceStore;
  token?: string;
  consoleDir?: string;
  getProfile?: () => WorkspaceProfile;
  getCapabilities?: () => Promise<unknown>;
  setProfile?: (profile: WorkspaceProfile) => Promise<void>;
}

/** Explicitly requested companion: loopback only, bearer protected, no shell routes. */
export async function createWorkspaceViewer(options: WorkspaceViewerOptions = {}): Promise<{ app: FastifyInstance; token: string }> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  const token = options.token ?? randomBytes(32).toString('hex');
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return reply.code(403).send({ error: { message: 'Use the local workspace link.' } });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return reply.code(403).send({ error: { message: 'Cross-origin workspace requests are not allowed.' } });
    if (!req.url.startsWith('/v1/')) return;
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const a = Buffer.from(supplied), b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: { message: 'Open the workspace link from your AI chat to reconnect.' } });
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    return payload;
  });
  app.get('/health', async () => ({ ok: true, version: HUSK_VERSION, mode: 'starter', profile: options.getProfile?.() ?? 'starter', uptimeSec: Math.floor(process.uptime()) }));
  app.get('/v1/capabilities', async () => options.getCapabilities?.() ?? { providers: [], selected: null });
  app.post('/v1/profile', async (req, reply) => {
    const body = req.body as { profile?: unknown; confirm?: unknown } | null;
    if (!body || (body.profile !== 'starter' && body.profile !== 'computer') || body.confirm !== true) return reply.code(400).send({ error: { message: 'Choose a profile and explicitly confirm the change.' } });
    if (!options.setProfile) return reply.code(409).send({ error: { message: 'Profile changes are available from an MCP workspace session.' } });
    try {
      await options.setProfile(body.profile);
      return { profile: options.getProfile?.() ?? body.profile };
    } catch (err) {
      return reply.code(409).send({ error: { message: (err as Error).message } });
    }
  });
  await registerWorkspaceRoutes(app, options.store);
  await app.register((await import('@fastify/static')).default, { root: options.consoleDir ?? consoleAssetsPath, prefix: '/', index: ['index.html'] });
  await app.ready();
  return { app, token };
}

export async function startWorkspaceViewer(options: WorkspaceViewerOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const { app, token } = await createWorkspaceViewer(options);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { url: `${address}/#token=${encodeURIComponent(token)}`, close: () => app.close() };
}
