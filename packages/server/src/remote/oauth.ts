import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { huskError } from '../errors.js';
import { AdvisoryWatch, blocking, describeAdvisories } from './advisories.js';
import type { Advisory } from './advisories.js';
import { Approvals } from './approvals.js';
import { checkClaim, formatClaim, newClaim } from './claim.js';
import { signAccessToken, verifyAccessToken } from './jwt.js';
import type { AccessClaims } from './jwt.js';
import { LIMITS, Limits } from './limits.js';
import { approvalPage, authorizePage, errorPage, linkPage } from './page.js';
import { RemoteStore, hashToken } from './state.js';
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
  /** The advisory check (advisories.ts), made before serving and then daily. `husk serve` always passes it. */
  advisories?: () => Promise<Advisory[]>;
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
/** How long the owner's passkey keeps the links under the public URL open in one browser. */
const OWNER_SESSION_MS = 8 * 3600 * 1000;
/** The most a sign-in step's body may be: they carry an id and a passkey's answer, never more. */
const STEP_BODY = 64 * 1024;
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

/** Where the chat apps Husk knows send the owner back: claude.ai, ChatGPT, or an app on their own device (http is loopback only). */
const KNOWN_RETURNS = new Set(['claude.ai', 'chatgpt.com']);
const knownReturn = (redirect: string): boolean => {
  const u = new URL(redirect);
  return u.protocol === 'http:' || KNOWN_RETURNS.has(u.hostname);
};

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
  readonly advisories?: AdvisoryWatch;
  /** What remote access's own port marks its requests with (auth.ts `PUBLIC_HEADER`): a secret of this process. */
  readonly mark = randomBytes(32).toString('hex');
  /** Why remote access is off, or undefined while it is on. Off, the public URL answers 404 to everything. */
  offReason: string | undefined;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, { client: string; redirectUri: string; challenge: string; owner: string; expiresAt: number }>();
  /** Bumped by off and reset: a token request that began before either gets nothing. */
  private epoch = 0;
  /**
   * Owner sessions, by hash: the owner's passkey proved in one browser, for
   * which links under the public URL then open (auth.ts). A link is in the
   * chat, so it is never enough alone.
   */
  private readonly sessions = new Map<string, { expiresAt: number }>();
  /** The passkey challenges for those, by id, one try each. */
  private readonly presence = new Map<string, { challenge: string; expiresAt: number }>();
  /** Told when links under the public URL must stop opening: every one, or one app's (app.ts). */
  private readonly revokers: Array<(client?: string) => void> = [];

  constructor(opts: RemoteOptions) {
    const url = parsePublicUrl(opts.publicUrl);
    this.origin = url.origin;
    this.host = url.hostname;
    this.resource = `${url.origin}/mcp`;
    this.store = new RemoteStore(opts.dir);
    this.now = opts.now ?? Date.now;
    this.approvals = new Approvals(url.origin, this.now);
    this.limits = new Limits(this.now);
    if (opts.advisories) this.advisories = new AdvisoryWatch(opts.advisories, this.now);
  }

  /** No owner, no apps, no tokens, nothing approved: `husk remote reset`. A claim code for whoever comes next. */
  async reset(): Promise<string> {
    this.epoch++;
    await this.store.reset();
    await this.store.load();
    this.store.current.origin = this.origin;
    this.approvals.clear();
    this.pending.clear();
    this.codes.clear();
    this.revokeLinks();
    return this.newClaimCode();
  }

  /** Call `fn` whenever links under the public URL must stop opening: with an app's id for that app's, without one for all. */
  onRevoke(fn: (client?: string) => void): void {
    this.revokers.push(fn);
  }

  private revokeLinks(client?: string): void {
    if (client === undefined) {
      this.sessions.clear();
      this.presence.clear();
    }
    for (const fn of this.revokers) fn(client);
  }

  /** Whether `session` is an owner session still in date: what links under the public URL need besides their own token. */
  ownerSession(session: string | undefined): boolean {
    const s = session ? this.sessions.get(hashToken(session)) : undefined;
    return s !== undefined && this.now() < s.expiresAt;
  }

  /** A registered app, by its own key only: `__proto__` and the like are no app at all. */
  private clientOf(id: unknown) {
    const clients = this.store.current.clients;
    return typeof id === 'string' && Object.hasOwn(clients, id) ? clients[id] : undefined;
  }

  /** What an app registered as, for the computers it makes. */
  appName(id: string): string {
    return this.clientOf(id)?.name ?? 'A chat app';
  }

  /**
   * Remote access off (the design's §6): every token revoked, the signing key
   * gone, nothing pending or approved, and the public URL a 404 until it is
   * switched on again. The owner stays, so signing back in is a passkey away.
   */
  async off(reason: string): Promise<void> {
    this.offReason = reason;
    this.epoch++;
    this.pending.clear();
    this.codes.clear();
    this.approvals.clear();
    this.revokeLinks();
    await this.store.revokeAll();
  }

  /** On again after off, unless a high or critical advisory stands: it is checked again first. */
  async on(): Promise<void> {
    if (this.advisories) await this.advisories.run();
    const stands = blocking(this.advisories?.list ?? []);
    if (stands.length) {
      throw huskError('E_CONFIG', `remote access stays off while a high or critical advisory stands against this install:\n${describeAdvisories(stands)}`, {
        hint: 'upgrade Husk, then start it again',
      });
    }
    this.offReason = undefined;
  }

  /** One app signed out from the console: forgotten, with its tokens and anything approved for it. */
  async signOut(client: string): Promise<boolean> {
    this.approvals.forget(client);
    for (const [k, p] of this.pending) if (p.client === client) this.pending.delete(k);
    for (const [k, c] of this.codes) if (c.client === client) this.codes.delete(k);
    this.revokeLinks(client);
    return this.store.forget(client);
  }

  /** What `GET /v1/remote` shows: on or off and why, the owner, the apps signed in, and the last advisory check. */
  status() {
    const s = this.store.current;
    const w = this.advisories;
    return {
      on: this.offReason === undefined,
      ...(this.offReason !== undefined ? { offReason: this.offReason } : {}),
      publicUrl: this.origin,
      endpoint: this.resource,
      owner: Boolean(s.owner),
      apps: Object.entries(s.clients).flatMap(([id, c]) => (c.signedIn ? [{ id, name: c.name, createdAt: c.signedIn }] : [])),
      advisories: w?.list ?? [],
      ...(w?.checkedAt ? { checkedAt: w.checkedAt } : {}),
      ...(w?.error ? { checkError: w.error } : {}),
    };
  }

  /** The overview's few words on it, for Husk Bar: on or off and why, and what an advisory check found. */
  brief() {
    const s = this.status();
    const n = s.advisories.length;
    const warning = n ? `${n} ${n === 1 ? 'advisory' : 'advisories'} against this install: upgrade Husk` : s.checkError ? 'could not check for advisories' : undefined;
    return { on: s.on, publicUrl: s.publicUrl, apps: s.apps.length, ...(s.offReason !== undefined ? { offReason: s.offReason } : {}), ...(warning ? { warning } : {}) };
  }

  /** The server is stopping: no more checks. */
  close(): void {
    this.advisories?.stop();
  }

  /** After each daily check: a high or critical advisory switches remote access off, and says why. */
  private async enforce(): Promise<void> {
    const stands = blocking(this.advisories?.list ?? []);
    if (!stands.length || this.offReason !== undefined) return;
    const what = stands.map((a) => `${a.name}@${a.version}: ${a.title} (${a.severity})`).join('; ');
    await this.off(`An advisory switched it off: ${what}. Upgrade Husk, then start it again.`);
  }

  /** Whether `key` may make another request this minute; if not, the 429 is sent. */
  allow(reply: FastifyReply, ...keys: Array<[string, number]>): boolean {
    if (keys.every(([k, max]) => this.limits.take(k, max))) return true;
    void reply.code(429).header('retry-after', '60').send({ error: 'too_many_requests', error_description: 'too many requests: try again in a minute' });
    return false;
  }

  /**
   * Before serving: the advisory check, where a high or critical advisory
   * refuses to start, with no flag to serve anyway (the design's §8); then the
   * state. With no owner yet, a fresh claim code to print where the person can
   * see it. `warnings` are for the terminal: lesser advisories, or a check that
   * could not be made, which is tried again every hour.
   */
  async start(): Promise<{ claimCode?: string; movedFrom?: string; warnings: string[] }> {
    const warnings: string[] = [];
    const w = this.advisories;
    if (w) {
      await w.run();
      const stands = blocking(w.list);
      if (stands.length) {
        throw huskError('E_CONFIG', `remote access will not start while a high or critical advisory stands against this install:\n${describeAdvisories(stands)}`, {
          hint: 'upgrade Husk, then start it again',
        });
      }
      if (w.error) warnings.push(`could not check for security advisories (${w.error}); trying again every hour`);
      else if (w.list.length) warnings.push(`advisories against this install, none high or critical:\n${describeAdvisories(w.list)}`);
      w.schedule(() => this.enforce());
    }
    await this.store.load();
    // The passkey and every token belong to the name they were made under: a new name starts over.
    const was = this.store.current.origin;
    if (was && was !== this.origin) await this.store.reset();
    this.store.current.origin = this.origin;
    await this.store.save();
    await this.store.signingKey();
    return {
      ...(this.store.current.owner ? {} : { claimCode: await this.newClaimCode() }),
      ...(was && was !== this.origin ? { movedFrom: was } : {}),
      warnings,
    };
  }

  /** A new claim code, replacing any earlier one. Only while there is no owner. */
  async newClaimCode(): Promise<string> {
    if (this.store.current.owner) throw huskError('E_CONFIG', 'this Husk already has an owner', { hint: 'run `husk remote reset` on the machine to start over' });
    const { code, stored } = newClaim(this.now());
    this.store.current.claim = stored;
    // A new code ends the old one everywhere, a sign-in that already typed it included.
    for (const p of this.pending.values()) delete p.claimed;
    await this.store.save();
    return formatClaim(code);
  }

  /** The owner's access token, checked: signed here, for /mcp under this URL, in date, by an owner and an app that still exist. */
  async verify(token: string): Promise<AccessClaims | undefined> {
    const { kid, publicKey } = await this.store.signingKey();
    const claims = verifyAccessToken(token, publicKey, kid, { iss: this.origin, aud: this.resource, now: Math.floor(this.now() / 1000) });
    const state = this.store.current;
    if (!claims || state.owner?.id !== claims.sub || !this.clientOf(claims.client_id)) return undefined;
    // From a family a reused refresh token ended: dead with it, not at the end of its hour.
    if (claims.fam && state.revoked && Object.hasOwn(state.revoked, claims.fam)) return undefined;
    return claims;
  }

  /**
   * Tokens for `client`, or undefined when something ended its right to them
   * while the request was on its way: off, a reset, a sign-out, or a reused
   * refresh token in its family. Nothing awaits between those checks and the mint.
   */
  private async issue(client: string, owner: string, family: string, epoch: number) {
    const { kid, privateKey } = await this.store.signingKey();
    const state = this.store.current;
    const app = this.clientOf(client);
    if (epoch !== this.epoch || this.offReason !== undefined || state.owner?.id !== owner || !app) return undefined;
    const refresh = this.store.mintRefresh(family, client, owner, this.now());
    if (!refresh) return undefined;
    app.signedIn ??= new Date(this.now()).toISOString();
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
      fam: family,
    });
    await this.store.save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: 'husk' };
  }

  /** Room for one more sign-in in flight. For an app the owner already let in, the oldest of an app never let in makes way. */
  private roomForSignIn(signedIn: boolean): boolean {
    if (room(this.pending, this.now())) return true;
    if (!signedIn) return false;
    for (const [k, p] of this.pending) {
      if (!this.clientOf(p.client)?.signedIn) {
        this.pending.delete(k);
        return true;
      }
    }
    return false;
  }

  /**
   * Budgets: a sign-in or an approval in flight has its own, keyed on an id
   * only whoever started it knows, so a flood from anyone else cannot starve
   * it. Anything naming no live one shares one budget.
   */
  private allowStep(reply: FastifyReply, key: string | undefined): boolean {
    return this.allow(reply, key ? [key, LIMITS.step] : ['sign-in', LIMITS.signIn]);
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
      // RFC 9207: every answer sent back carries `iss`, which ChatGPT checks before its fixed redirect.
      authorization_response_iss_parameter_supported: true,
    }));

    app.post('/oauth/register', { bodyLimit: STEP_BODY }, async (req, reply) => {
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
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const client = this.clientOf(q.client_id);
      // An app the owner already let in has a budget of its own; everyone else shares one.
      if (!this.allow(reply, client?.signedIn ? [`authorize:${q.client_id}`, LIMITS.signIn] : ['sign-in', LIMITS.signIn])) return reply;
      // Nothing is sent back before the owner has signed in: anyone can register
      // an app, so a redirect from here would make this URL an open redirect.
      const fail = (why: string) => reply.code(400).type('text/html').send(errorPage(why));
      if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) return fail('This chat app or its return address is not registered with this Husk.');
      if (q.response_type !== 'code') return fail('The chat app asked for something other than a sign-in code. Remove Husk from the app, then add it again.');
      if (q.code_challenge_method !== 'S256' || !q.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
        return fail('The chat app did not protect its sign-in with PKCE (S256), which this Husk requires.');
      }
      if (q.resource && q.resource.replace(/\/$/, '') !== this.resource) return fail(`The chat app asked to sign in to another server, not ${this.resource}.`);
      if (!this.roomForSignIn(Boolean(client.signedIn))) return fail('Too many sign-ins are in progress. Try again in a few minutes.');
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
        knownReturn: knownReturn(q.redirect_uri),
        claimed: Boolean(this.store.current.owner),
      });
      return reply.header('content-security-policy', csp).header('cache-control', 'no-store').header('x-frame-options', 'DENY').type('text/html').send(html);
    });

    // The owner's sign-in options: the passkey to use.
    app.post('/oauth/start', { bodyLimit: STEP_BODY }, async (req, reply) => {
      const id = (req.body as { request?: unknown } | undefined)?.request;
      const p = this.live(id);
      if (!this.allowStep(reply, p && `request:${String(id)}`)) return reply;
      if (!p || !this.store.current.owner) return reply.code(400).send({ error: 'invalid_request', error_description: 'this sign-in has expired: start again from the chat app' });
      return this.passkeyOptions(p);
    });

    app.post('/oauth/claim', { bodyLimit: STEP_BODY }, async (req, reply) => {
      const body = (req.body ?? {}) as { request?: unknown; code?: unknown };
      const p = this.live(body.request);
      // The claim code itself dies on its fifth wrong guess, whoever is guessing.
      if (!this.allowStep(reply, p && `request:${String(body.request)}`)) return reply;
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

    app.post('/oauth/passkey', { bodyLimit: STEP_BODY }, async (req, reply) => {
      const body = (req.body ?? {}) as { request?: unknown; credential?: Record<string, unknown> };
      const p = this.live(body.request);
      if (!this.allowStep(reply, p && `request:${String(body.request)}`)) return reply;
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

    app.post('/oauth/consent', { bodyLimit: STEP_BODY }, async (req, reply) => {
      const body = (req.body ?? {}) as { request?: unknown; allow?: unknown };
      const p = this.live(body.request);
      if (!this.allowStep(reply, p && `request:${String(body.request)}`)) return reply;
      if (!p || !p.owner) return reply.code(400).send({ error: 'invalid_request', error_description: 'sign in first' });
      this.pending.delete(body.request as string);
      const u = new URL(p.redirectUri);
      if (body.allow === true && room(this.codes, this.now())) {
        const code = randomBytes(32).toString('base64url');
        this.codes.set(code, { client: p.client, redirectUri: p.redirectUri, challenge: p.challenge, owner: p.owner, expiresAt: this.now() + CODE_TTL_MS });
        u.searchParams.set('code', code);
      } else {
        u.searchParams.set('error', body.allow === true ? 'temporarily_unavailable' : 'access_denied');
      }
      u.searchParams.set('iss', this.origin);
      if (p.state) u.searchParams.set('state', p.state);
      return { redirect: u.toString() };
    });

    // A link a remote chat gave its person (a handoff, a look at a computer)
    // starts here: the chat holds the link too, and so may whoever it was
    // shown to, so it opens only once the owner's passkey has been used in
    // this browser. The page then goes on to the console with an owner session.
    app.get('/oauth/link', async (_req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const { html, csp } = linkPage();
      return reply.header('content-security-policy', csp).header('cache-control', 'no-store').header('x-frame-options', 'DENY').type('text/html').send(html);
    });

    app.post('/oauth/link/start', { bodyLimit: STEP_BODY }, async (_req, reply) => {
      if (!this.allow(reply, ['sign-in', LIMITS.signIn])) return reply;
      const owner = this.store.current.owner;
      if (!owner) return reply.code(400).send({ error: 'invalid_request', error_description: 'this Husk has no owner yet' });
      if (!room(this.presence, this.now())) return reply.code(400).send({ error: 'temporarily_unavailable', error_description: 'too many sign-ins are in progress: try again in a few minutes' });
      const id = randomBytes(16).toString('base64url');
      const challenge = randomBytes(32).toString('base64url');
      this.presence.set(id, { challenge, expiresAt: this.now() + PENDING_TTL_MS });
      return {
        id,
        create: false,
        publicKey: { challenge, rpId: this.host, allowCredentials: [{ type: 'public-key', id: owner.credential.id }], userVerification: 'required', timeout: 120_000 },
      };
    });

    app.post('/oauth/link', { bodyLimit: STEP_BODY }, async (req, reply) => {
      const body = (req.body ?? {}) as { id?: unknown; credential?: Record<string, unknown> };
      const p = typeof body.id === 'string' ? this.presence.get(body.id) : undefined;
      if (!this.allowStep(reply, p && `link:${String(body.id)}`)) return reply;
      // One try per challenge, right or wrong.
      if (p) this.presence.delete(body.id as string);
      const owner = this.store.current.owner;
      if (!p || this.now() >= p.expiresAt || !owner) return reply.code(400).send({ error: 'invalid_request', error_description: 'this sign-in has expired: open the link again' });
      const c = body.credential ?? {};
      const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
      try {
        owner.credential.signCount = verifyAssertion(
          { id: str('id'), clientDataJSON: str('clientDataJSON'), authenticatorData: str('authenticatorData'), signature: str('signature') },
          owner.credential,
          { challenge: p.challenge, origin: this.origin, rpId: this.host },
        );
      } catch (err) {
        if (err instanceof WebAuthnError) return reply.code(403).send({ error: 'access_denied', error_description: err.message });
        throw err;
      }
      await this.store.save();
      const session = randomBytes(32).toString('base64url');
      for (const [k, s] of this.sessions) if (this.now() >= s.expiresAt) this.sessions.delete(k);
      this.sessions.set(hashToken(session), { expiresAt: this.now() + OWNER_SESSION_MS });
      return { session, expiresIn: OWNER_SESSION_MS / 1000 };
    });

    // A remote chat's tool call waiting for the owner's word (approvals.ts).
    app.get('/oauth/approve', async (req, reply) => {
      const a = this.approvals.pending((req.query as { id?: unknown } | undefined)?.id);
      if (!this.allowStep(reply, a && `approve:${a.id}`)) return reply;
      if (!a) return reply.code(404).type('text/html').send(errorPage('This approval has expired, or was already answered. Ask the chat to try again.'));
      const { html, csp } = approvalPage({ id: a.id, app: a.app, tool: a.tool, summary: a.summary, detail: a.detail });
      return reply.header('content-security-policy', csp).header('cache-control', 'no-store').header('x-frame-options', 'DENY').type('text/html').send(html);
    });

    app.post('/oauth/approve/start', { bodyLimit: STEP_BODY }, async (req, reply) => {
      const a = this.approvals.pending((req.body as { id?: unknown } | undefined)?.id);
      if (!this.allowStep(reply, a && `approve:${a.id}`)) return reply;
      const owner = this.store.current.owner;
      if (!a || !owner) return reply.code(404).send({ error: 'invalid_request', error_description: 'this approval has expired, or was already answered' });
      a.challenge = randomBytes(32).toString('base64url');
      return {
        create: false,
        publicKey: { challenge: a.challenge, rpId: this.host, allowCredentials: [{ type: 'public-key', id: owner.credential.id }], userVerification: 'required', timeout: 120_000 },
      };
    });

    app.post('/oauth/approve', { bodyLimit: STEP_BODY }, async (req, reply) => {
      const body = (req.body ?? {}) as { id?: unknown; allow?: unknown; hour?: unknown; credential?: Record<string, unknown> };
      const a = this.approvals.pending(body.id);
      if (!this.allowStep(reply, a && `approve:${a.id}`)) return reply;
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

    app.post('/oauth/token', { bodyLimit: STEP_BODY }, async (req, reply) => {
      void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
      const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
      const deny = (error: string, why: string, status = 400) => reply.code(status).send({ error, error_description: why });
      const client = form.get('client_id') ?? '';
      const known = this.clientOf(client);
      // An app the owner let in, or one holding a code they just gave it, has a budget of its own; everyone else shares one.
      const own = Boolean(known?.signedIn) || [...this.codes.values()].some((c) => c.client === client);
      if (!this.allow(reply, own ? [`token:${client}`, LIMITS.token] : ['tokens', LIMITS.tokens])) return reply;
      if (!known) return deny('invalid_client', 'unknown client_id', 401);
      const resource = form.get('resource');
      if (resource && resource.replace(/\/$/, '') !== this.resource) return deny('invalid_target', `tokens here are for ${this.resource}`);
      const owner = this.store.current.owner;
      const epoch = this.epoch;
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        const issued = this.codes.get(code);
        this.codes.delete(code);
        if (!issued || this.now() >= issued.expiresAt || issued.client !== client || issued.redirectUri !== form.get('redirect_uri')) {
          return deny('invalid_grant', 'the code is unknown, used, expired, or for another app');
        }
        if (!safeEqual(sha256b64(form.get('code_verifier') ?? ''), issued.challenge)) return deny('invalid_grant', 'the PKCE verifier does not match');
        if (owner?.id !== issued.owner) return deny('invalid_grant', 'the owner has changed');
        return (await this.issue(client, issued.owner, randomUUID(), epoch)) ?? deny('invalid_grant', 'remote access was switched off or reset, or this app signed out');
      }
      if (form.get('grant_type') === 'refresh_token') {
        const spent = await this.store.spendRefresh(form.get('refresh_token') ?? '', client, this.now());
        if (!spent || owner?.id !== spent.owner) return deny('invalid_grant', 'the refresh token is unknown, used or expired');
        return (await this.issue(client, spent.owner, spent.family, epoch)) ?? deny('invalid_grant', 'the refresh token is unknown, used or expired');
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
