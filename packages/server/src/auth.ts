import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { huskError } from './errors.js';

/** Paths that answer without a token, whatever else is configured. */
const PUBLIC_PATHS = new Set(['/health', '/healthz']);

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '' || h === 'ip6-localhost') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::ffff:127.0.0.1';
  return false;
}

/**
 * Decide whether this bind is allowed.
 *
 * Binding 0.0.0.0 with no token puts a shell-execution API on the local network.
 * That is not a warning-level mistake, so it is a hard error with the fix in it.
 */
export function assertBindIsSafe(host: string, token: string | undefined): void {
  if (token) return;
  if (isLoopbackHost(host)) return;
  throw huskError(
    'E_CONFIG',
    `refusing to bind ${host} without an auth token: this API can execute shell commands`,
    {
      hint: 'set HUSK_TOKEN=$(openssl rand -hex 32) before `husk serve --host ' + host + '`, or bind 127.0.0.1',
    },
  );
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Compare a fixed-size digest-shaped buffer so length alone does not leak.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim();
}

export interface AuthOptions {
  token?: string | undefined;
  /** Extra prefixes served without a token, e.g. the console bundle at `/`. */
  publicPrefixes?: string[];
}

/**
 * Bearer auth as an onRequest hook.
 *
 * When no token is configured every request passes -- but the server only ever
 * reaches that state on a loopback bind, because `assertBindIsSafe` runs first.
 */
export function installAuth(app: FastifyInstance, opts: AuthOptions): void {
  const token = opts.token;
  const publicPrefixes = opts.publicPrefixes ?? [];

  app.decorate('huskAuthEnabled', Boolean(token));

  app.addHook('onRequest', async (req, reply) => {
    if (!token) return;
    const path = req.url.split('?')[0] ?? '/';
    if (PUBLIC_PATHS.has(path)) return;
    if (req.method === 'OPTIONS') return;
    if (publicPrefixes.some((p) => path === p || path.startsWith(p))) return;

    const supplied = bearerToken(req) ?? queryToken(req);
    if (supplied && constantTimeEquals(supplied, token)) return;

    await reply.code(401).send({
      error: {
        code: 'E_NO_CREDENTIALS',
        message: supplied ? 'bearer token is not valid' : 'missing Authorization: Bearer <token>',
        hint: 'HUSK_TOKEN is set on this server -- send the same value as a bearer token',
      },
    });
  });
}

/**
 * EventSource and WebSocket clients in a browser cannot set headers, so a token in
 * the query string is accepted for those two transports only.
 */
function queryToken(req: FastifyRequest): string | undefined {
  const accept = req.headers.accept;
  const isSse = typeof accept === 'string' && accept.includes('text/event-stream');
  const isWs = typeof req.headers.upgrade === 'string' && req.headers.upgrade.toLowerCase() === 'websocket';
  if (!isSse && !isWs) return undefined;
  const q = (req.query ?? {}) as Record<string, unknown>;
  const t = q['token'] ?? q['access_token'];
  return typeof t === 'string' ? t : undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    huskAuthEnabled: boolean;
  }
}
