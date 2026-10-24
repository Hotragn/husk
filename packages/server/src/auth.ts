import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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

/** The host part of a `Host` header: `[::1]:7377` -> `[::1]`, `localhost:7377` -> `localhost`. */
export function hostnameOf(header: string | undefined): string {
  const h = (header ?? '').trim();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? '';
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
  /**
   * What a short-lived link token opens, if it is one. Such a token reaches only
   * SCOPED_PREFIXES, and the routes there check it against the one computer or
   * handoff it names (`req.huskScope`).
   */
  scopeOf?: (token: string) => string | undefined;
  /** The server is bound to a loopback address: answer only loopback Host names, even with a token. */
  loopbackOnly?: boolean;
}

/** The only routes a link token reaches. The handoff list is not among them. */
const SCOPED_PREFIXES = ['/v1/handoffs/', '/v1/scoped/'];

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

  const refuse = (reply: FastifyReply, status: number, message: string, hint: string) =>
    reply.code(status).send({ error: { code: 'E_NO_CREDENTIALS', message, hint } });

  app.addHook('onRequest', async (req, reply) => {
    // A web page may not drive this server, token or not. A browser sends
    // Origin on every cross-site request and on every WebSocket, and nothing
    // stops a page from opening a WebSocket to 127.0.0.1. A loopback origin is
    // this console, or its dev server.
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let originHost = '';
      try {
        originHost = new URL(origin).hostname;
      } catch {
        // not a URL: refused below
      }
      if (!isLoopbackHost(originHost)) {
        return refuse(reply, 403, `requests from ${origin} are refused`, 'open the console from this machine');
      }
    } else if (origin === 'null') {
      return refuse(reply, 403, 'requests from an opaque origin are refused', 'open the console from this machine');
    }

    // DNS rebinding: evil.example resolves to 127.0.0.1 and the browser sends
    // `Host: evil.example`. On a loopback bind only loopback names are answered,
    // whether or not a token is set. A missing Host is not a loopback name.
    if (!token || opts.loopbackOnly) {
      const host = hostnameOf(req.headers.host);
      if (!host || !isLoopbackHost(host)) {
        return refuse(
          reply,
          token ? 403 : 401,
          'this server answers only to localhost, 127.0.0.1 and [::1]',
          'reach it by a loopback address, or set HUSK_TOKEN and bind another address to serve it under another name',
        );
      }
    }
    if (!token) return;

    // Decide on the route the router matched, never on the raw URL: the router
    // decodes the path first, so `/%761/computers` is `/v1/computers` to it.
    const route = req.routeOptions?.url;
    if (route === undefined) {
      // Nothing matched: a 404 follows, and answering it without a token says nothing.
      if (req.method === 'GET' || req.method === 'HEAD') return;
    } else {
      if (PUBLIC_PATHS.has(route)) return;
      if (req.method === 'OPTIONS') return;
      // The console's own page and assets. They hold no data: every API call the
      // page makes carries the token, and the whole API is under /v1. Without this
      // the console could never load from a link, because the token rides in the
      // #fragment, which a browser does not send.
      if ((req.method === 'GET' || req.method === 'HEAD') && !route.startsWith('/v1')) return;
      if (publicPrefixes.some((p) => route.startsWith(p))) return;
    }

    const supplied = bearerToken(req) ?? queryToken(req);
    if (supplied && constantTimeEquals(supplied, token)) return;
    if (supplied && opts.scopeOf && route && SCOPED_PREFIXES.some((p) => route.startsWith(p))) {
      const scope = opts.scopeOf(supplied);
      if (scope) {
        req.huskScope = scope;
        return;
      }
    }

    return refuse(
      reply,
      401,
      supplied ? 'bearer token is not valid' : 'missing Authorization: Bearer <token>',
      'HUSK_TOKEN is set on this server -- send the same value as a bearer token',
    );
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
  interface FastifyRequest {
    /** Set when a link token, not the server token, let this request in. */
    huskScope?: string;
  }
}
