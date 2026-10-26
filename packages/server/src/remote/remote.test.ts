import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagerLike } from '../deps.js';
import { serve } from '../serve.js';
import { buildTestApp } from '../testing.js';
import type { TestApp } from '../testing.js';
import { CLAIM_ATTEMPTS, CLAIM_TTL_MS, checkClaim, formatClaim, newClaim } from './claim.js';
import { signAccessToken, verifyAccessToken } from './jwt.js';
import type { AccessClaims } from './jwt.js';
import { Remote, parsePublicUrl } from './oauth.js';
import { decodeCbor, verifyAssertion, verifyRegistration } from './webauthn.js';

const ISS = 'https://box.tail1234.ts.net';
const AUD = `${ISS}/mcp`;

describe('access tokens', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const claims = (over: Partial<AccessClaims> = {}): AccessClaims => ({
    iss: ISS, aud: AUD, sub: 'owner', client_id: 'c1', scope: 'husk', iat: 1000, nbf: 1000, exp: 4600, jti: 'j1', ...over,
  });
  const check = (token: string, now = 2000) => verifyAccessToken(token, publicKey, 'k1', { iss: ISS, aud: AUD, now });
  const forge = (header: unknown, body: unknown, signature = '') =>
    `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${signature}`;

  it('reads back a token it signed, in date and for this audience', () => {
    expect(check(signAccessToken(privateKey, 'k1', claims()))).toMatchObject({ sub: 'owner', client_id: 'c1' });
  });

  it('refuses one out of date, not yet valid, or for another URL or issuer', () => {
    expect(check(signAccessToken(privateKey, 'k1', claims()), 4600)).toBeUndefined();
    expect(check(signAccessToken(privateKey, 'k1', claims({ nbf: 3000 })))).toBeUndefined();
    expect(check(signAccessToken(privateKey, 'k1', claims({ aud: 'https://old.ngrok.app/mcp' })))).toBeUndefined();
    expect(check(signAccessToken(privateKey, 'k1', claims({ iss: 'https://evil.example' })))).toBeUndefined();
  });

  it('refuses alg none, HS256 with the public key as secret, another key id, and another key', () => {
    expect(check(forge({ alg: 'none', kid: 'k1' }, claims()))).toBeUndefined();
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const head = `${Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}`;
    const hmac = createHash('sha256').update(String(pem)).update(head).digest('base64url');
    expect(check(`${head}.${hmac}`)).toBeUndefined();
    expect(check(signAccessToken(privateKey, 'k2', claims()))).toBeUndefined();
    expect(check(signAccessToken(generateKeyPairSync('ed25519').privateKey, 'k1', claims()))).toBeUndefined();
    expect(check('not.a.token!')).toBeUndefined();
  });
});

describe('the owner’s claim code', () => {
  it('is 80 bits, printed in groups of four, and read without case or dashes', () => {
    const { code, stored } = newClaim(0);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(formatClaim(code)).toMatch(/^(\w{4}-){3}\w{4}$/);
    expect(checkClaim(stored, formatClaim(code).toLowerCase(), 1)).toBe('ok');
  });

  it('dies on the fifth wrong guess, and after 15 minutes', () => {
    const { code, stored } = newClaim(0);
    for (let i = 0; i < CLAIM_ATTEMPTS; i++) expect(checkClaim(stored, 'WRONG-WRONG-WRONG', 1)).toBe('wrong');
    expect(checkClaim(stored, code, 1)).toBe('spent');
    const fresh = newClaim(0);
    expect(checkClaim(fresh.stored, fresh.code, CLAIM_TTL_MS)).toBe('expired');
    expect(checkClaim(undefined, fresh.code, 1)).toBe('spent');
  });
});

/** A software authenticator: what a phone or a security key does, with node:crypto. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error('test cbor: unsupported');
}

const RP = 'box.tail1234.ts.net';
const ORIGIN = `https://${RP}`;

function authenticator(kind: 'ec' | 'ed25519' = 'ec') {
  const { privateKey, publicKey } = kind === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const cose =
    kind === 'ec'
      ? new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]])
      : new Map<unknown, unknown>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, 'base64url')]]);
  const id = randomBytes(16);
  let count = 0;
  const rpHash = (rp: string) => createHash('sha256').update(rp).digest();
  const counter = () => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(++count);
    return b;
  };
  const clientData = (type: string, challenge: string, origin = ORIGIN) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString('base64url');
  return {
    id: id.toString('base64url'),
    create(challenge: string, opts: { rp?: string; flags?: number } = {}) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(id.length);
      const authData = Buffer.concat([rpHash(opts.rp ?? RP), Buffer.from([opts.flags ?? 0x45]), counter(), Buffer.alloc(16), idLength, id, cbor(cose)]);
      const attestationObject = cbor(new Map<unknown, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url');
      return { clientDataJSON: clientData('webauthn.create', challenge), attestationObject };
    },
    get(challenge: string, opts: { origin?: string; key?: KeyObject; count?: number } = {}) {
      const clientDataJSON = clientData('webauthn.get', challenge, opts.origin);
      if (opts.count !== undefined) count = opts.count - 1;
      const authData = Buffer.concat([rpHash(RP), Buffer.from([0x05]), counter()]);
      const signed = Buffer.concat([authData, createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()]);
      const signature = (kind === 'ec' ? sign('sha256', signed, opts.key ?? privateKey) : sign(null, signed, opts.key ?? privateKey)).toString('base64url');
      return { id: id.toString('base64url'), clientDataJSON, authenticatorData: authData.toString('base64url'), signature };
    },
  };
}

describe('the owner’s passkey', () => {
  const expected = (challenge: string) => ({ challenge, origin: ORIGIN, rpId: RP });

  for (const kind of ['ec', 'ed25519'] as const) {
    it(`registers one and checks its sign-ins (${kind === 'ec' ? 'ES256' : 'EdDSA'})`, () => {
      const device = authenticator(kind);
      const credential = verifyRegistration(device.create('reg-1'), expected('reg-1'));
      expect(credential.id).toBe(device.id);
      expect(verifyAssertion(device.get('sign-1'), credential, expected('sign-1'))).toBe(2);
    });
  }

  it('refuses a registration for another site, another challenge, or without the person verified', () => {
    const device = authenticator();
    expect(() => verifyRegistration(device.create('a'), expected('b'))).toThrow(/challenge/);
    expect(() => verifyRegistration(device.create('a', { rp: 'evil.example' }), expected('a'))).toThrow(/another site/);
    expect(() => verifyRegistration(device.create('a', { flags: 0x41 }), expected('a'))).toThrow(/not verified/);
  });

  it('refuses a sign-in from another origin, by another key, or replayed', () => {
    const device = authenticator();
    const credential = verifyRegistration(device.create('r'), expected('r'));
    expect(() => verifyAssertion(device.get('s', { origin: 'https://evil.example' }), credential, expected('s'))).toThrow(/origin/);
    const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(() => verifyAssertion(device.get('s', { key: stranger }), credential, expected('s'))).toThrow(/signature/);
    credential.signCount = verifyAssertion(device.get('s'), credential, expected('s'));
    // A clone of the authenticator, signing properly but behind the count the owner's has reached.
    expect(() => verifyAssertion(device.get('t', { count: credential.signCount }), credential, expected('t'))).toThrow(/counter went backwards/);
  });

  it('reads no further than the bytes it was given', () => {
    expect(() => decodeCbor(Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff]))).toThrow(/truncated/);
    expect(() => decodeCbor(Buffer.from([0x9f]))).toThrow(/length/);
    expect(() => decodeCbor(Buffer.from([0xc0, 0x00]))).toThrow(/type/);
    expect(decodeCbor(cbor(new Map([[1, 'a']]))).value).toEqual(new Map([[1, 'a']]));
  });
});

describe('the public URL', () => {
  it('is https and a host, nothing more', () => {
    expect(parsePublicUrl('https://box.tail1234.ts.net').hostname).toBe(RP);
    for (const bad of ['http://box.ts.net', 'https://box.ts.net/husk', 'https://u:p@box.ts.net', 'https://box.ts.net/?a=1', 'box.ts.net']) {
      expect(() => parsePublicUrl(bad)).toThrow();
    }
  });
});

describe('switching remote access on', () => {
  let home = '';
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'husk-remote-serve-'));
    vi.stubEnv('HUSK_HOME', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });
  /** Only `status` is asked of it: which providers are here, and how isolated. */
  const manager = (isolated: Record<string, boolean | 'guardrails'>) =>
    ({
      async status() {
        return Object.entries(isolated).map(([name, i]) => ({
          name, description: name, priority: 1, available: true, isolated: i !== false,
          isolationKind: i === 'guardrails' ? 'guardrails' : 'kernel',
        }));
      },
    }) as unknown as ManagerLike;

  it('refuses anywhere but loopback, and a provider with no real boundary', async () => {
    const remote = (provider: string) => ({ publicUrl: ORIGIN, provider });
    await expect(serve({ host: '0.0.0.0', token: 't', port: 0, remote: remote('docker'), deps: { manager: manager({ docker: true }) } })).rejects.toThrow(/loopback/);
    await expect(serve({ port: 0, remote: remote('local'), deps: { manager: manager({ local: 'guardrails' }) } })).rejects.toThrow(/isolated computer/);
    await expect(serve({ port: 0, remote: remote('podman'), deps: { manager: manager({ docker: true }) } })).rejects.toThrow(/isolated computer/);
  });
});

describe('remote access, from a chat app to a call', () => {
  const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
  let dir = '';
  let harness: TestApp;
  let remote: Remote;
  let claim = '';
  let now = 1_000_000;
  const calls: Array<{ owner: string; client: string; name: string; body: unknown }> = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'husk-remote-'));
    now = 1_000_000;
    calls.length = 0;
    remote = new Remote({ publicUrl: ORIGIN, dir, now: () => now });
    claim = (await remote.start()).claimCode!;
    harness = await buildTestApp({
      token: 'local-token',
      remote,
      remoteMcp: async (request, { owner, client, name }) => {
        calls.push({ owner, client, name, body: await request.json() });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { headers: { 'content-type': 'application/json' } });
      },
    });
  });
  afterEach(async () => {
    await harness.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  /** A request under the public URL, as a tunnel delivers it. */
  const pub = (method: 'GET' | 'POST', url: string, opts: { json?: unknown; form?: Record<string, string>; token?: string; origin?: string } = {}) =>
    harness.app.inject({
      method,
      url,
      headers: {
        host: RP,
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(opts.json !== undefined ? { payload: opts.json as object } : {}),
      ...(opts.form ? { payload: new URLSearchParams(opts.form).toString() } : {}),
    });

  async function register(): Promise<string> {
    const r = await pub('POST', '/oauth/register', { json: { redirect_uris: [CALLBACK], client_name: 'Claude' } });
    expect(r.statusCode).toBe(201);
    return (r.json() as { client_id: string }).client_id;
  }

  /** Up to the consent screen: the request id the page carries. */
  async function authorize(client: string, verifier: string, extra: Record<string, string> = {}) {
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: `${ORIGIN}/mcp`, ...extra });
    const page = await pub('GET', `/oauth/authorize?${q}`);
    return { page, request: /"request":"([^"]+)"/.exec(page.body)?.[1] ?? '' };
  }

  async function consent(request: string) {
    const r = await pub('POST', '/oauth/consent', { json: { request, allow: true }, origin: ORIGIN });
    const back = new URL((r.json() as { redirect: string }).redirect);
    return back;
  }

  async function tokens(client: string, code: string, verifier: string) {
    return pub('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client, code_verifier: verifier, resource: `${ORIGIN}/mcp` } });
  }

  /** The whole first sign-in: the claim code, a new passkey, consent, tokens. */
  async function claimAndSignIn(device = authenticator()) {
    const client = await register();
    const verifier = randomBytes(32).toString('base64url');
    const { request } = await authorize(client, verifier);
    const options = (await pub('POST', '/oauth/claim', { json: { request, code: claim }, origin: ORIGIN })).json() as { publicKey: { challenge: string } };
    const made = await pub('POST', '/oauth/passkey', { json: { request, credential: device.create(options.publicKey.challenge) }, origin: ORIGIN });
    expect(made.statusCode).toBe(200);
    const back = await consent(request);
    const t = (await tokens(client, back.searchParams.get('code')!, verifier)).json() as { access_token: string; refresh_token: string };
    return { client, device, ...t };
  }

  it('takes an app from registration to a call: claim code, a new passkey, consent, tokens', async () => {
    const { client, access_token } = await claimAndSignIn();
    const r = await pub('POST', '/mcp', { token: access_token, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r.statusCode).toBe(200);
    expect(calls).toEqual([{ owner: remote.store.current.owner!.id, client, name: 'Claude', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }]);
  });

  it('answers /mcp without a good token with where to sign in', async () => {
    const none = await pub('POST', '/mcp', { json: {} });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await pub('POST', '/mcp', { json: {}, token: 'not-a-token' });
    expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
    const meta = (await pub('GET', '/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
    expect(meta).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    expect(calls).toEqual([]);
  });

  it('lets the owner in the next time with the passkey alone, and nobody claims it twice', async () => {
    const { device } = await claimAndSignIn();
    const client = await register();
    const verifier = randomBytes(32).toString('base64url');
    const { page, request } = await authorize(client, verifier);
    expect(page.body).toContain('"claimed":true');
    expect((await pub('POST', '/oauth/claim', { json: { request, code: claim }, origin: ORIGIN })).statusCode).toBe(400);
    const options = (await pub('POST', '/oauth/start', { json: { request }, origin: ORIGIN })).json() as { publicKey: { challenge: string } };
    // Another device's passkey, even a well-formed one, is not the owner's.
    const stranger = authenticator();
    expect((await pub('POST', '/oauth/passkey', { json: { request, credential: stranger.get(options.publicKey.challenge) }, origin: ORIGIN })).statusCode).toBe(403);
    const again = (await pub('POST', '/oauth/start', { json: { request }, origin: ORIGIN })).json() as { publicKey: { challenge: string } };
    expect((await pub('POST', '/oauth/passkey', { json: { request, credential: device.get(again.publicKey.challenge) }, origin: ORIGIN })).statusCode).toBe(200);
    const back = await consent(request);
    expect(back.searchParams.get('state')).toBe('st8');
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
    expect((await tokens(client, back.searchParams.get('code')!, verifier)).statusCode).toBe(200);
  });

  it('spends the claim code on the fifth wrong guess', async () => {
    const client = await register();
    const { request } = await authorize(client, 'v'.repeat(43));
    for (let i = 0; i < 5; i++) expect((await pub('POST', '/oauth/claim', { json: { request, code: 'AAAA-AAAA-AAAA-AAAA' }, origin: ORIGIN })).statusCode).toBe(403);
    const last = await pub('POST', '/oauth/claim', { json: { request, code: claim }, origin: ORIGIN });
    expect(last.statusCode).toBe(403);
    expect(last.body).toContain('husk remote claim');
  });

  it('rotates a refresh token on use, and a copy used twice ends the family', async () => {
    const { client, refresh_token } = await claimAndSignIn();
    const refresh = (token: string) => pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: token, client_id: client } });
    const next = await refresh(refresh_token);
    expect(next.statusCode).toBe(200);
    const second = (next.json() as { refresh_token: string }).refresh_token;
    // The first token again: copied. Its family, the second token included, is gone.
    expect((await refresh(refresh_token)).statusCode).toBe(400);
    expect((await refresh(second)).statusCode).toBe(400);
  });

  it('refuses a code twice, a wrong verifier, another resource, and an expired token', async () => {
    const client = await register();
    const device = authenticator();
    const verifier = randomBytes(32).toString('base64url');
    const { request } = await authorize(client, verifier);
    const options = (await pub('POST', '/oauth/claim', { json: { request, code: claim }, origin: ORIGIN })).json() as { publicKey: { challenge: string } };
    await pub('POST', '/oauth/passkey', { json: { request, credential: device.create(options.publicKey.challenge) }, origin: ORIGIN });
    const code = (await consent(request)).searchParams.get('code')!;
    expect((await tokens(client, code, 'w'.repeat(43))).json()).toMatchObject({ error: 'invalid_grant' });
    // A wrong verifier spends the code too: it is single-use either way.
    expect((await tokens(client, code, verifier)).statusCode).toBe(400);
    const other = await pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: 'x', client_id: client, resource: 'https://old.ngrok.app/mcp' } });
    expect(other.json()).toMatchObject({ error: 'invalid_target' });

    const fresh = await claimAndSignInAgain(client, device);
    now += 3600_000;
    expect((await pub('POST', '/mcp', { token: fresh, json: {} })).statusCode).toBe(401);
  });

  /** A second authorization for the same app, by the owner's passkey. */
  async function claimAndSignInAgain(client: string, device: ReturnType<typeof authenticator>): Promise<string> {
    const verifier = randomBytes(32).toString('base64url');
    const { request } = await authorize(client, verifier);
    const options = (await pub('POST', '/oauth/start', { json: { request }, origin: ORIGIN })).json() as { publicKey: { challenge: string } };
    await pub('POST', '/oauth/passkey', { json: { request, credential: device.get(options.publicKey.challenge) }, origin: ORIGIN });
    const code = (await consent(request)).searchParams.get('code')!;
    return ((await tokens(client, code, verifier)).json() as { access_token: string }).access_token;
  }

  it('never sends an unregistered redirect anywhere, and needs S256', async () => {
    const client = await register();
    const evil = await pub('GET', `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: 'https://evil.example/cb', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' })}`);
    expect(evil.statusCode).toBe(400);
    expect(evil.headers.location).toBeUndefined();
    const plain = await pub('GET', `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: CALLBACK, code_challenge: 'c'.repeat(43), code_challenge_method: 'plain' })}`);
    expect(plain.statusCode).toBe(302);
    expect(new URL(String(plain.headers.location)).searchParams.get('error')).toBe('invalid_request');
    expect((await pub('POST', '/oauth/register', { json: { redirect_uris: ['http://evil.example/cb'] } })).statusCode).toBe(400);
  });

  it('lets the owner approve one call with the passkey, at a page under the public URL', async () => {
    const { device } = await claimAndSignIn();
    const ask = { owner: remote.store.current.owner!.id, client: 'c1', app: 'Claude', tool: 'shell', summary: '$ make deploy', digest: 'd1' };
    const first = remote.approvals.check(ask);
    expect(first).toMatchObject({ ok: false, state: 'asked' });
    const id = new URL((first as { link: string }).link).searchParams.get('id')!;
    expect(remote.approvals.check(ask)).toMatchObject({ ok: false, state: 'waiting' });
    const page = await pub('GET', `/oauth/approve?id=${id}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('$ make deploy');
    // Not without the owner's passkey: a stranger's, well formed, is refused.
    const options = (await pub('POST', '/oauth/approve/start', { json: { id }, origin: ORIGIN })).json() as { publicKey: { challenge: string } };
    const stranger = authenticator();
    expect((await pub('POST', '/oauth/approve', { json: { id, allow: true, credential: stranger.get(options.publicKey.challenge) }, origin: ORIGIN })).statusCode).toBe(403);
    const again = (await pub('POST', '/oauth/approve/start', { json: { id }, origin: ORIGIN })).json() as { publicKey: { challenge: string } };
    expect((await pub('POST', '/oauth/approve', { json: { id, allow: true, credential: device.get(again.publicKey.challenge) }, origin: ORIGIN })).statusCode).toBe(200);
    // Approved once, for that call once.
    expect(remote.approvals.check(ask)).toEqual({ ok: true });
    expect(remote.approvals.check(ask)).toMatchObject({ ok: false, state: 'asked' });
  });

  it('takes a no without the passkey, and asks afresh next time', async () => {
    await claimAndSignIn();
    const ask = { owner: remote.store.current.owner!.id, client: 'c1', app: 'Claude', tool: 'browser_type', summary: 'type 8 characters into e12', digest: 'd2' };
    const id = new URL((remote.approvals.check(ask) as { link: string }).link).searchParams.get('id')!;
    expect((await pub('POST', '/oauth/approve', { json: { id, allow: false }, origin: ORIGIN })).statusCode).toBe(200);
    expect(remote.approvals.check(ask)).toMatchObject({ ok: false, state: 'denied' });
    expect(remote.approvals.check(ask)).toMatchObject({ ok: false, state: 'asked' });
    // Ten minutes unanswered is a no too: the page is gone.
    const late = new URL((remote.approvals.check({ ...ask, digest: 'd3' }) as { link: string }).link).searchParams.get('id')!;
    now += 10 * 60_000;
    expect((await pub('GET', `/oauth/approve?id=${late}`)).statusCode).toBe(404);
  });

  it('limits a flood by what a tunnel does not hide, never the address', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await pub('POST', '/oauth/register', { json: { redirect_uris: [CALLBACK] } })).statusCode;
    expect(last).toBe(429);
    now += 60_000;
    expect((await pub('POST', '/oauth/register', { json: { redirect_uris: [CALLBACK] } })).statusCode).toBe(201);
  });

  it('opens a handoff link under the public URL, with its own token in the header alone', async () => {
    const local = (url: string, payload: object) => harness.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer local-token' }, payload });
    const computer = (await local('/v1/computers', {})).json() as { id: string };
    const handoff = (await local(`/v1/computers/${computer.id}/handoffs`, { reason: 'Sign in to your bank.' })).json() as { handoffId: string; token: string };
    expect((await pub('GET', `/v1/handoffs/${handoff.handoffId}`, { token: handoff.token })).statusCode).toBe(200);
    // Not this machine's own token, not a token in the URL, and not another route.
    expect((await pub('GET', `/v1/handoffs/${handoff.handoffId}`, { token: 'local-token' })).statusCode).toBe(401);
    expect((await pub('GET', `/v1/handoffs/${handoff.handoffId}?token=${handoff.token}`)).statusCode).toBe(401);
    expect((await pub('GET', '/v1/handoffs', { token: handoff.token })).statusCode).toBe(404);
  });

  it('keeps the console’s API off the public URL, and the remote paths off this machine’s', async () => {
    expect((await pub('GET', '/v1/computers', { token: 'local-token' })).statusCode).toBe(404);
    expect((await pub('GET', '/v1/overview', { token: 'local-token' })).statusCode).toBe(404);
    // The page a link opens holds nothing: it is served, and can do nothing without that link's token.
    expect((await pub('GET', '/')).statusCode).toBe(200);
    const local = (url: string) => harness.app.inject({ method: 'GET', url, headers: { authorization: 'Bearer local-token' } });
    expect((await local('/.well-known/oauth-authorization-server')).statusCode).toBe(404);
    expect((await local('/v1/remote')).json()).toMatchObject({ on: true, publicUrl: ORIGIN, owner: false });
    // Another site's page cannot drive the sign-in.
    expect((await pub('POST', '/oauth/claim', { json: { request: 'x', code: claim }, origin: 'https://evil.example' })).statusCode).toBe(403);
  });
});
