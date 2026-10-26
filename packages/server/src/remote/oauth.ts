import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { huskError } from '../errors.js';
import { Approvals } from './approvals.js';
import { checkClaim, formatClaim, newClaim } from './claim.js';
import { signAccessToken, verifyAccessToken } from './jwt.js';
import type { AccessClaims } from './jwt.js';
import { LIMITS, Limits } from './limits.js';
import { approvalPage, authorizePage, errorPage } from './page.js';
import { RemoteStore } from './state.js';
import { ALGORITHMS, WebAuthnError, verifyAssertion, verifyRegistration } from './webauthn.js';

/**
 * Remote access's own OAuth 2.1 authorization server, per the MCP
 * authorization spec: protected resource metadata (RFC 9728), server metadata
 * (RFC 8414), dynamic client registration (RFC 7591), PKCE with S256 only, and
 * resource indicators (RFC 8707). The only person who can sign in is the
 * owner: whoever first redeems the claim code printed on the machine, with a
 * passkey after that. There are no passwords and no other users.
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 */

export interface RemoteOptions {
  /** https://<host>, nothing more: the server's name for OAuth, its tokens and the passkey. */
  publicUrl: string;
  /** Where its state lives: ~/.husk/remote. */
  dir: string;
  now?: () => number;
}

/** The public URL as remote access needs it: https and a host, no path, query or credentials. */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw huskError('E_CONFIG', `--public-url "${raw}" is not a URL`, { hint: 'give the tunnel’s fixed name, e.g. --public-url https://box.tail1234.ts.net' });
  }
  if (url.protocol !== 'https:') throw huskError('E_CONFIG', 'remote access needs an https public URL', { hint: 'a tunnel such as Tailscale Funnel gives one' });
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw huskError('E_CONFIG', `--public-url must be only https://<host>, not ${raw}`, { hint: 'leave out any path: Husk serves /mcp under it itself' });
  }
  return url;
}

/** Paths the public URL reaches. Everything else on it is a 404: the console and the API stay on this machine. */
export function isRemotePath(route: string): boolean {
  return route === '/mcp' || route.startsWith('/.well-known/oauth-') || route.startsWith('/oauth/');
}

const ACCESS_TTL_SEC = 3600;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
/**
 * Apps register themselves without signing in, so their number is capped. At
 * the cap, apps that never got a token and registered over an hour ago make way.
 */
const MAX_CLIENTS = 50;
/** Sign-ins and codes in flight live in memory: a page anyone can open is a cap, not a leak. */
const MAX_IN_FLIGHT = 200;

/** Drop what has expired; true when there is room for one more. */
function room<T extends { expiresAt: number }>(map: Map<string, T>, now: number): boolean {
  for (const [k, v] of map) if (now >= v.expiresAt) map.delete(k);
  return map.size < MAX_IN_FLIGHT;
}

interface Pending {
  client: string;
  redirectUri: string;
  state?: string;
  challenge: string;
  expiresAt: number;
  /** The WebAuthn challenge outstanding for this request. */
  webauthn?: string;
  claimed?: boolean;
  owner?: string;
}

const sha256b64 = (s: string) => createHash('sha256').update(s).digest('base64url');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A redirect a chat app may register: https, or http to this machine (a CLI's loopback). */
function allowedRedirect(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2000) return false;
  try {
    const u = new URL(raw);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

export class Remote {
  readonly origin: string;
  readonly host: string;
  readonly resource: string;
  readonly store: RemoteStore;
  readonly approvals: Approvals;
  readonly limits: Limits;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, { client: string; redirectUri: string; challenge: string; owner: string; expiresAt: number }>();

  constructor(opts: RemoteOptions) {
    const url = parsePublicUrl(opts.publicUrl);
    this.origin = url.origin;
    this.host = url.hostname;
    this.resource = `${url.origin}/mcp`;
    this.store = new RemoteStore(opts.dir);
    this.now = opts.now ?? Date.now;
    this.approvals = new Approvals(url.origin, this.now);
    this.limits = new Limits(this.now);
  }

  /** No owner, no apps, no tokens, nothing approved: `husk remote reset`. A claim code for whoever comes next. */
  async reset(): Promise<string> {
    await this.store.reset();
    await this.store.load();
    this.approvals.clear();
    this.pending.clear();
    this.codes.clear();
    return this.newClaimCode();
  }

  /** Whether `key` may make another request this minute; if not, the 429 is sent. */
  allow(reply: FastifyReply, ...keys: Array<[string, number]>): boolean {
    if (keys.every(([k, max]) => this.limits.take(k, max))) return true;
    void reply.code(429).header('retry-after', '60').send({ error: 'too_many_requests', error_description: 'too many requests: try again in a minute' });
    return false;
  }

  /** Load the state. With no owner yet, a fresh claim code to print where the person can see it. */
  async start(): Promise<{ claimCode?: string }> {
    await this.store.load();
    await this.store.signingKey();
    return this.store.current.owner ? {} : { claimCode: await this.newClaimCode() };
  }

  /** A new claim code, replacing any earlier one. Only while there is no owner. */
  async newClaimCode(): Promise<string> {
    if (this.store.current.owner) throw huskError('E_CONFIG', 'this Husk already has an owner', { hint: 'run `husk remote reset` on the machine to start over' });
    const { code, stored } = newClaim(this.now());
    this.store.current.claim = stored;
    await this.store.save();
    return formatClaim(code);
  }

  /** The owner's access token, checked: signed here, for /mcp under this URL, in date, by an owner and an app that still exist. */
  async verify(token: string): Promise<AccessClaims | undefined> {
    const { kid, publicKey } = await this.store.signingKey();
    const claims = verifyAccessToken(token, publicKey, kid, { iss: this.origin, aud: this.resource, now: Math.floor(this.now() / 1000) });
    const state = this.store.current;
    if (!claims || state.owner?.id !== claims.sub || !state.clients[claims.client_id]) return undefined;
    return claims;
  }

  private async issue(client: string, owner: string, family: string) {
    const app = this.store.current.clients[client];
    if (app && !app.signedIn) app.signedIn = new Date(this.now()).toISOString();
    const { kid, privateKey } = await this.store.signingKey();
    const now = Math.floor(this.now() / 1000);
    const access = signAccessToken(privateKey, kid, {
      iss: this.origin,
      aud: this.resource,
      sub: owner,
      client_id: client,
      scope: 'husk',
      iat: now,
      nbf: now,
      exp: now + ACCESS_TTL_SEC,
      jti: randomUUID(),
    });
    const refresh = await this.store.mintRefresh(family, client, owner, this.now());
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: 'husk' };
  }

  /** A pending authorization still in date, or undefined. */
  private live(id: unknown): Pending | undefined {
    const p = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (p && this.now() < p.expiresAt) return p;
    if (typeof id === 'string') this.pending.delete(id);
    return undefined;
  }

  private passkeyOptions(p: Pending) {
    const challenge = randomBytes(32).toString('base64url');
    p.webauthn = challenge;
    const owner = this.store.current.owner;
    if (owner) {
      return {
        create: false,
        publicKey: {
          challenge,
          rpId: this.host,
          allowCredentials: [{ type: 'public-key', id: owner.credential.id }],
          userVerification: 'required',
          timeout: 120_000,
        },
      };
    }
    return {
      create: true,
      publicKey: {
        challenge,
        rp: { id: this.host, name: 'Husk' },
        user: { id: randomBytes(16).toString('base64url'), name: 'owner', displayName: 'Husk owner' },
        pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 120_000,
      },
    };
  }

  routes(app: FastifyInstance): void {
    const resourceMetadata = () => ({
      resource: this.resource,
      authorization_servers: [this.origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['husk'],
      resource_name: 'Husk',
    });
    app.get('/.well-known/oauth-protected-resource', async () => resourceMetadata());
    app.get('/.well-known/oauth-protected-resource/mcp', async () => resourceMetadata());
    app.get('/.well-known/oauth-authorization-server', async () => ({
      issuer: this.origin,
      authorization_endpoint: `${this.origin}/oauth/authorize`,
      token_endpoint: `${this.origin}/oauth/token`,
      registration_endpoint: `${this.origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['husk'],
    }));

    app.post('/oauth/register', async (req, reply) => {
      if (!this.allow(reply, ['register', LIMITS.register])) return reply;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const uris = body.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(allowedRedirect)) {
        return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, or http to this machine' });
      }
      const method = body.token_endpoint_auth_method ?? 'none';
      if (method !== 'none') return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'only public clients (token_endpoint_auth_method "none")' });
      const state = this.store.current;
      if (Object.keys(state.clients).length >= MAX_CLIENTS) {
        for (const [id, c] of Object.entries(state.clients)) {
          if (!c.signedIn && this.now() - Date.parse(c.createdAt) > 3600_000) delete state.clients[id];
        }
      }
      if (Object.keys(state.clients).length >= MAX_CLIENTS) {
        return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'too many apps have registered: remove some with `husk remote reset`' });
      }
      const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'A chat app';
      const id = randomUUID();
      state.clients[id] = { name, redirectUris: uris as string[], createdAt: new Date(this.now()).toISOString() };
      await this.store.save();
      return reply.code(201).send({
        client_id: id,
        client_id_issued_at: Math.floor(this.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    });

    app.get('/oauth/authorize', async (req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const client = q.client_id ? this.store.current.clients[q.client_id] : undefined;
      // Only to a redirect the app registered; anything else is shown here, never sent on.
      if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
        return reply.code(400).type('text/html').send(errorPage('This chat app or its return address is not registered with this Husk.'));
      }
      const back = (error: string) => {
        const u = new URL(q.redirect_uri!);
        u.searchParams.set('error', error);
        if (q.state) u.searchParams.set('state', q.state);
        return reply.redirect(u.toString(), 302);
      };
      if (q.response_type !== 'code') return back('unsupported_response_type');
      if (q.code_challenge_method !== 'S256' || !q.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return back('invalid_request');
      if (q.resource && q.resource.replace(/\/$/, '') !== this.resource) return back('invalid_target');
      if (!room(this.pending, this.now())) return back('temporarily_unavailable');
      const request = randomBytes(32).toString('base64url');
      this.pending.set(request, {
        client: q.client_id!,
        redirectUri: q.redirect_uri,
        ...(q.state ? { state: q.state } : {}),
        challenge: q.code_challenge,
        expiresAt: this.now() + PENDING_TTL_MS,
      });
      const { html, csp } = authorizePage({
        request,
        client: client.name,
        redirectHost: new URL(q.redirect_uri).host,
        claimed: Boolean(this.store.current.owner),
      });
      return reply.header('content-security-policy', csp).header('cache-control', 'no-store').header('x-frame-options', 'DENY').type('text/html').send(html);
    });

    // The owner's sign-in options: the passkey to use.
    app.post('/oauth/start', async (req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const p = this.live((req.body as { request?: unknown } | undefined)?.request);
      if (!p || !this.store.current.owner) return reply.code(400).send({ error: 'invalid_request', error_description: 'this sign-in has expired: start again from the chat app' });
      return this.passkeyOptions(p);
    });

    app.post('/oauth/claim', async (req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const body = (req.body ?? {}) as { request?: unknown; code?: unknown };
      const p = this.live(body.request);
      const state = this.store.current;
      if (!p || state.owner) return reply.code(400).send({ error: 'invalid_request', error_description: 'this Husk already has an owner, or the sign-in has expired' });
      const result = checkClaim(state.claim, typeof body.code === 'string' ? body.code : '', this.now());
      await this.store.save();
      if (result !== 'ok') {
        const why = {
          wrong: 'That is not the claim code.',
          expired: 'That claim code has expired: run `husk remote claim` on the machine for a new one.',
          spent: 'That claim code no longer works: run `husk remote claim` on the machine for a new one.',
        }[result];
        return reply.code(403).send({ error: 'access_denied', error_description: why });
      }
      p.claimed = true;
      return this.passkeyOptions(p);
    });

    app.post('/oauth/passkey', async (req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const body = (req.body ?? {}) as { request?: unknown; credential?: Record<string, unknown> };
      const p = this.live(body.request);
      const challenge = p?.webauthn;
      if (!p || !challenge) return reply.code(400).send({ error: 'invalid_request', error_description: 'this sign-in has expired: start again from the chat app' });
      delete p.webauthn;
      const c = body.credential ?? {};
      const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
      const expected = { challenge, origin: this.origin, rpId: this.host };
      const state = this.store.current;
      try {
        if (!state.owner) {
          if (!p.claimed) return reply.code(403).send({ error: 'access_denied', error_description: 'claim this Husk first' });
          const credential = verifyRegistration({ clientDataJSON: str('clientDataJSON'), attestationObject: str('attestationObject') }, expected);
          state.owner = { id: randomUUID(), credential, createdAt: new Date(this.now()).toISOString() };
          delete state.claim;
        } else {
          state.owner.credential.signCount = verifyAssertion(
            { id: str('id'), clientDataJSON: str('clientDataJSON'), authenticatorData: str('authenticatorData'), signature: str('signature') },
            state.owner.credential,
            expected,
          );
        }
      } catch (err) {
        if (err instanceof WebAuthnError) return reply.code(403).send({ error: 'access_denied', error_description: err.message });
        throw err;
      }
      await this.store.save();
      p.owner = state.owner.id;
      return { ok: true };
    });

    app.post('/oauth/consent', async (req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const body = (req.body ?? {}) as { request?: unknown; allow?: unknown };
      const p = this.live(body.request);
      if (!p || !p.owner) return reply.code(400).send({ error: 'invalid_request', error_description: 'sign in first' });
      this.pending.delete(body.request as string);
      const u = new URL(p.redirectUri);
      if (body.allow === true && room(this.codes, this.now())) {
        const code = randomBytes(32).toString('base64url');
        this.codes.set(code, { client: p.client, redirectUri: p.redirectUri, challenge: p.challenge, owner: p.owner, expiresAt: this.now() + CODE_TTL_MS });
        u.searchParams.set('code', code);
        u.searchParams.set('iss', this.origin);
      } else {
        u.searchParams.set('error', body.allow === true ? 'temporarily_unavailable' : 'access_denied');
      }
      if (p.state) u.searchParams.set('state', p.state);
      return { redirect: u.toString() };
    });

    // A remote chat's tool call waiting for the owner's word (approvals.ts).
    app.get('/oauth/approve', async (req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const a = this.approvals.pending((req.query as { id?: unknown } | undefined)?.id);
      if (!a) return reply.code(404).type('text/html').send(errorPage('This approval has expired, or was already answered. Ask the chat to try again.'));
      const { html, csp } = approvalPage({ id: a.id, app: a.app, tool: a.tool, summary: a.summary });
      return reply.header('content-security-policy', csp).header('cache-control', 'no-store').header('x-frame-options', 'DENY').type('text/html').send(html);
    });

    app.post('/oauth/approve/start', async (req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const a = this.approvals.pending((req.body as { id?: unknown } | undefined)?.id);
      const owner = this.store.current.owner;
      if (!a || !owner) return reply.code(404).send({ error: 'invalid_request', error_description: 'this approval has expired, or was already answered' });
      a.challenge = randomBytes(32).toString('base64url');
      return {
        create: false,
        publicKey: { challenge: a.challenge, rpId: this.host, allowCredentials: [{ type: 'public-key', id: owner.credential.id }], userVerification: 'required', timeout: 120_000 },
      };
    });

    app.post('/oauth/approve', async (req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const body = (req.body ?? {}) as { id?: unknown; allow?: unknown; hour?: unknown; credential?: Record<string, unknown> };
      const a = this.approvals.pending(body.id);
      const owner = this.store.current.owner;
      if (!a || !owner) return reply.code(404).send({ error: 'invalid_request', error_description: 'this approval has expired, or was already answered' });
      // Saying no needs nothing: whoever holds the link can only stop a call.
      if (body.allow !== true) {
        this.approvals.decide(a, false, false);
        return { ok: true };
      }
      const challenge = a.challenge;
      delete a.challenge;
      if (!challenge) return reply.code(400).send({ error: 'invalid_request', error_description: 'start with the passkey' });
      const c = body.credential ?? {};
      const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
      try {
        owner.credential.signCount = verifyAssertion(
          { id: str('id'), clientDataJSON: str('clientDataJSON'), authenticatorData: str('authenticatorData'), signature: str('signature') },
          owner.credential,
          { challenge, origin: this.origin, rpId: this.host },
        );
      } catch (err) {
        if (err instanceof WebAuthnError) return reply.code(403).send({ error: 'access_denied', error_description: err.message });
        throw err;
      }
      await this.store.save();
      this.approvals.decide(a, true, body.hour === true);
      return { ok: true };
    });

    app.post('/oauth/token', async (req, reply) => {
      void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
      const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
      const deny = (error: string, why: string, status = 400) => reply.code(status).send({ error, error_description: why });
      const client = form.get('client_id') ?? '';
      if (!this.allow(reply, ['tokens', LIMITS.tokens], [`token:${client}`, LIMITS.token])) return reply;
      if (!this.store.current.clients[client]) return deny('invalid_client', 'unknown client_id', 401);
      const resource = form.get('resource');
      if (resource && resource.replace(/\/$/, '') !== this.resource) return deny('invalid_target', `tokens here are for ${this.resource}`);
      const owner = this.store.current.owner;
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        const issued = this.codes.get(code);
        this.codes.delete(code);
        if (!issued || this.now() >= issued.expiresAt || issued.client !== client || issued.redirectUri !== form.get('redirect_uri')) {
          return deny('invalid_grant', 'the code is unknown, used, expired, or for another app');
        }
        if (!safeEqual(sha256b64(form.get('code_verifier') ?? ''), issued.challenge)) return deny('invalid_grant', 'the PKCE verifier does not match');
        if (owner?.id !== issued.owner) return deny('invalid_grant', 'the owner has changed');
        return this.issue(client, issued.owner, randomUUID());
      }
      if (form.get('grant_type') === 'refresh_token') {
        const spent = await this.store.spendRefresh(form.get('refresh_token') ?? '', client, this.now());
        if (!spent || owner?.id !== spent.owner) return deny('invalid_grant', 'the refresh token is unknown, used or expired');
        return this.issue(client, spent.owner, spent.family);
      }
      return deny('unsupported_grant_type', 'authorization_code or refresh_token');
    });
  }

  /** Answer a request to /mcp that carries no good token, as the spec says: where to get one. */
  challenge(reply: FastifyReply, given: boolean): FastifyReply {
    const metadata = `${this.origin}/.well-known/oauth-protected-resource/mcp`;
    const error = given ? ', error="invalid_token"' : '';
    return reply
      .code(401)
      .header('www-authenticate', `Bearer resource_metadata="${metadata}"${error}`)
      .send({ error: { code: 'E_NO_CREDENTIALS', message: 'remote access needs the owner’s sign-in', hint: 'add this Husk to the chat app as a connector; it will ask you to sign in' } });
  }
}

/** The access token on a request, from its Authorization header only: remotely, never from a URL. */
export function accessTokenOf(req: FastifyRequest): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim());
  return m?.[1];
}
