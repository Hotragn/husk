import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Buffer } from 'node:buffer';
import { HUSK_VERSION } from '@husk-ai/core';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { consoleAssetsPath } from '@husk-ai/console-assets';
import { bearerToken, hostnameOf, isLoopbackHost } from './auth.js';
import { sendError } from './errors.js';
import type { HandoffRegistry } from './handoffs.js';
import type { ScopedTokens } from './scoped-tokens.js';
import { registerHandoffRoutes, registerScopedComputerRoutes, scopeCovers, takeOver } from './routes/handoffs.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

export type WorkspaceProfile = 'starter' | 'computer';
export interface WorkspaceViewerOptions {
  store?: WorkspaceStore;
  token?: string;
  consoleDir?: string;
  getProfile?: () => WorkspaceProfile;
  getCapabilities?: () => Promise<unknown>;
  setProfile?: (profile: WorkspaceProfile) => Promise<void>;
  /**
   * Handoffs a person can take over from this viewer, and the short-lived
   * tokens that open them. A token opens one computer (and its handoffs) or one
   * computer-less handoff, never the workspace API; the viewer token opens none.
   */
  handoffs?: { registry: HandoffRegistry; tokens: ScopedTokens; describe: (computerId: string) => Promise<ScopedComputer | undefined> };
}

/** A chat's computer, as its card and its link see it. */
export interface ScopedComputer {
  computerId: string;
  label?: string;
  state: string;
}

/** Explicitly requested companion: loopback only, bearer protected, no shell routes. */
export async function createWorkspaceViewer(options: WorkspaceViewerOptions = {}): Promise<{ app: FastifyInstance; token: string }> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  const token = options.token ?? randomBytes(32).toString('hex');
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    const name = hostnameOf(host);
    if (!name || !isLoopbackHost(name)) return reply.code(403).send({ error: { message: 'Use the local workspace link.' } });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return reply.code(403).send({ error: { message: 'Cross-origin workspace requests are not allowed.' } });
    if (!req.url.startsWith('/v1/')) return;
    // Checked per request against a scoped token in the routes below.
    if (options.handoffs && (req.url.startsWith('/v1/handoffs/') || req.url.startsWith('/v1/scoped/'))) return;
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const a = Buffer.from(supplied), b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: { message: 'Open the workspace link from your AI chat to reconnect.' } });
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
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
  if (options.handoffs) {
    const { registry, tokens, describe } = options.handoffs;
    const scopeOf = (req: FastifyRequest): string | undefined => tokens.verify(bearerToken(req) ?? '');
    // A person's take-over ends with their Give back, or with this viewer.
    const closing = new AbortController();
    app.addHook('onClose', async () => closing.abort());
    await app.register(async (scoped) => {
      scoped.setErrorHandler((error, _req, reply) => sendError(reply, error));
      registerHandoffRoutes(scoped, {
        registry,
        authorize: (req, h) => scopeCovers(scopeOf(req), h),
      });
      registerScopedComputerRoutes(scoped, { scopeOf, describe, registry, takeOver: (id) => takeOver(registry, id, closing.signal) });
    });
  }
  await app.register((await import('@fastify/static')).default, { root: options.consoleDir ?? consoleAssetsPath, prefix: '/', index: ['index.html'] });
  await app.ready();
  return { app, token };
}

export async function startWorkspaceViewer(options: WorkspaceViewerOptions = {}): Promise<{ url: string; origin: string; close: () => Promise<void> }> {
  const { app, token } = await createWorkspaceViewer(options);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { url: `${address}/#token=${encodeURIComponent(token)}`, origin: address, close: () => app.close() };
}

/**
 * The link a person opens to take over one handoff, or to look at one computer.
 * The short-lived token rides in the fragment, which browsers never send, so it
 * stays out of requests, logs and Referer headers; the console moves it to
 * session storage and strips it from the address bar.
 */
export function handoffLink(origin: string, handoffId: string, token: string): string {
  return `${origin}/#handoff=${encodeURIComponent(handoffId)}&token=${encodeURIComponent(token)}`;
}

export function computerLink(origin: string, computerId: string, token: string): string {
  return `${origin}/#computer=${encodeURIComponent(computerId)}&token=${encodeURIComponent(token)}`;
}

export { HandoffRegistry, PERSON_RUN, heldText, takenText } from './handoffs.js';
export { underControl } from './control.js';
export { ScopedTokens } from './scoped-tokens.js';
export type { PendingHandoff } from './handoffs.js';
