import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_HEADER } from '../auth.js';
import type { ManagerLike } from '../deps.js';
import { serve } from '../serve.js';
import { buildTestApp } from '../testing.js';
import type { TestApp } from '../testing.js';
import type { Advisory } from './advisories.js';
import { CLAIM_ATTEMPTS, CLAIM_TTL_MS, checkClaim, formatClaim, newClaim } from './claim.js';
import { signAccessToken, verifyAccessToken } from './jwt.js';
import type { AccessClaims } from './jwt.js';
import { LIMITS } from './limits.js';
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
    // Zero after a count is a copy starting over; zero every time is a passkey that keeps no count.
    expect(() => verifyAssertion(device.get('u', { count: 0 }), credential, expected('u'))).toThrow(/counter went backwards/);
    expect(verifyAssertion(device.get('v', { count: 0 }), { ...credential, signCount: 0 }, expected('v'))).toBe(0);
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

  it('serves remote access on a port of its own, and will not start while a high or critical advisory stands', async () => {
    let answer: unknown = {};
    const registry = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer));
    });
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    vi.stubEnv('HUSK_ADVISORY_ENDPOINT', `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`);
    const full = { ...manager({ docker: true }), list: async () => [], get: async () => null } as unknown as ManagerLike;
    const opts = { port: 0, reaperIntervalMs: 0, remote: { publicUrl: ORIGIN, provider: 'docker' }, deps: { manager: full } };
    try {
      answer = { minimist: [{ title: 'Prototype Pollution in minimist', severity: 'critical', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', vulnerable_versions: '<1.2.6' }] };
      await expect(serve(opts)).rejects.toThrow(/will not start[\s\S]*Prototype Pollution in minimist \(critical, affects <1\.2\.6\)/);
      answer = {};
      const server = await serve(opts);
      try {
        const token = server.app.husk.deps.config.token!;
        const status = (port: number, path: string, host: string) =>
          new Promise<number>((resolve, reject) => {
            httpRequest({ host: '127.0.0.1', port, path, headers: { host, authorization: `Bearer ${token}` } }, (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            })
              .on('error', reject)
              .end();
          });
        expect(server.remotePort).toBeGreaterThan(0);
        expect(await status(server.remotePort!, '/.well-known/oauth-authorization-server', RP)).toBe(200);
        // Whatever Host a tunnel passes on, its port reaches remote access alone, even with this machine's token.
        expect(await status(server.remotePort!, '/v1/computers', '127.0.0.1')).toBe(404);
        // And the API's port serves none of remote access, and answers loopback names only, whatever Host it is given.
        expect(await status(server.port, '/.well-known/oauth-authorization-server', '127.0.0.1')).toBe(404);
        expect(await status(server.port, '/.well-known/oauth-authorization-server', RP)).toBe(404);
        expect(await status(server.port, '/v1/computers', RP)).toBe(403);
        expect(await status(server.port, '/v1/computers', '127.0.0.1')).toBe(200);
      } finally {
        await server.close();
      }
    } finally {
      registry.close();
    }
  });
});

describe('advisories, and a new public URL', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'husk-remote-checks-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });
  const advisory = (severity: Advisory['severity']): Advisory => ({
    name: 'fastify', version: '5.12.5', title: 'a hole', severity, url: 'https://github.com/advisories/GHSA-0000-0000-0000', vulnerable: '<5.12.6',
  });

  it('will not start on a high or critical advisory, and only warns of a lesser one or a check it could not make', async () => {
    await expect(new Remote({ publicUrl: ORIGIN, dir, advisories: async () => [advisory('critical')] }).start()).rejects.toThrow(
      /will not start[\s\S]*fastify@5\.12\.5: a hole \(critical, affects <5\.12\.6\)/,
    );
    const lesser = new Remote({ publicUrl: ORIGIN, dir, advisories: async () => [advisory('moderate')] });
    expect((await lesser.start()).warnings.join('\n')).toContain('none high or critical');
    expect(lesser.brief()).toMatchObject({ on: true, warning: '1 advisory against this install: upgrade Husk' });
    lesser.close();
    const offline = new Remote({
      publicUrl: ORIGIN,
      dir,
      advisories: async () => {
        throw new Error('the npm registry answered 503');
      },
    });
    expect((await offline.start()).warnings.join('\n')).toContain('could not check for security advisories (the npm registry answered 503)');
    expect(offline.status()).toMatchObject({ on: true, checkError: 'the npm registry answered 503' });
    offline.close();
  });

  it('switches itself off when a later check finds one, and stays off while it stands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let found: Advisory[] = [];
    const remote = new Remote({ publicUrl: ORIGIN, dir, advisories: async () => found });
    await remote.start();
    found = [advisory('high')];
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(remote.status()).toMatchObject({ on: false, offReason: expect.stringContaining('fastify@5.12.5: a hole (high)') });
    await expect(remote.on()).rejects.toThrow(/stays off/);
    found = [];
    await remote.on();
    expect(remote.status().on).toBe(true);
    remote.close();
  });

  it('forgets the owner, apps and tokens when the public URL changes, and keeps them when it does not', async () => {
    const first = new Remote({ publicUrl: ORIGIN, dir });
    await first.start();
    const device = authenticator();
    first.store.current.owner = { id: 'o1', credential: verifyRegistration(device.create('r'), { challenge: 'r', origin: ORIGIN, rpId: RP }), createdAt: '' };
    await first.store.save();
    expect((await new Remote({ publicUrl: ORIGIN, dir }).start()).claimCode).toBeUndefined();
    const moved = new Remote({ publicUrl: 'https://new-name.tail9999.ts.net', dir });
    const started = await moved.start();
    expect(started).toMatchObject({ movedFrom: ORIGIN, claimCode: expect.any(String) });
    expect(moved.store.current.owner).toBeUndefined();
    expect((await new Remote({ publicUrl: 'https://new-name.tail9999.ts.net', dir }).start()).movedFrom).toBeUndefined();
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

  /** A request under the public URL, as remote access's own port hands it on (serve.ts `servePublic`). */
  const pub = (
    method: 'GET' | 'POST',
    url: string,
    opts: { json?: unknown; form?: Record<string, string>; token?: string; origin?: string; owner?: string; headers?: Record<string, string>; payload?: Buffer } = {},
  ) =>
    harness.app.inject({
      method,
      url,
      headers: {
        host: RP,
        [PUBLIC_HEADER]: remote.mark,
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.owner ? { 'x-husk-owner': opts.owner } : {}),
        ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.json !== undefined ? { payload: opts.json as object } : {}),
      ...(opts.form ? { payload: new URLSearchParams(opts.form).toString() } : {}),
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    });

  /** On this machine, with its token. */
  const here = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    harness.app.inject({ method, url, headers: { authorization: 'Bearer local-token' }, ...(payload ? { payload } : {}) });

  /** The owner's passkey used for links in a browser (`/oauth/link`): the session those links then need. */
  async function ownerSessionOf(device: ReturnType<typeof authenticator>): Promise<string> {
    const step = (await pub('POST', '/oauth/link/start', { json: {}, origin: ORIGIN })).json() as { id: string; publicKey: { challenge: string } };
    const opened = await pub('POST', '/oauth/link', { json: { id: step.id, credential: device.get(step.publicKey.challenge) }, origin: ORIGIN });
    expect(opened.statusCode).toBe(200);
    return (opened.json() as { session: string }).session;
  }

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

  it('lets no token minted in a race outlive the reuse of the one it came from', async () => {
    const { client, refresh_token } = await claimAndSignIn();
    const refresh = (token: string) => pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: token, client_id: client } });
    // Two refreshes with one token at once: one of them is a copy, whichever it is.
    const raced = await Promise.all([refresh(refresh_token), refresh(refresh_token)]);
    const won = raced.filter((r) => r.statusCode === 200).map((r) => (r.json() as { refresh_token: string }).refresh_token);
    expect(won.length).toBeLessThanOrEqual(1);
    // The original used once more: whatever the race minted is dead with its family.
    await refresh(refresh_token);
    for (const token of won) expect((await refresh(token)).statusCode).toBe(400);
  });

  it('switches off: every token revoked and the public URL a 404, until it is on again', async () => {
    const { client, device, access_token, refresh_token } = await claimAndSignIn();
    const local = (method: 'GET' | 'POST', url: string) => harness.app.inject({ method, url, headers: { authorization: 'Bearer local-token' } });
    expect((await local('POST', '/v1/remote/off')).json()).toMatchObject({ on: false, offReason: expect.stringContaining('Switched off'), apps: [] });
    expect((await pub('POST', '/mcp', { token: access_token, json: {} })).statusCode).toBe(404);
    expect((await pub('GET', '/.well-known/oauth-authorization-server')).statusCode).toBe(404);
    expect((await local('POST', '/v1/remote/on')).json()).toMatchObject({ on: true });
    // On again, nothing from before works: the key that signed it is gone, and so are the refresh tokens.
    expect((await pub('POST', '/mcp', { token: access_token, json: {} })).statusCode).toBe(401);
    expect((await pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token, client_id: client } })).statusCode).toBe(400);
    // The owner is still the owner: their passkey lets the app in again.
    const again = await claimAndSignInAgain(client, device);
    expect((await pub('POST', '/mcp', { token: again, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).statusCode).toBe(200);
  });

  it('signs one app out from this machine, its tokens with it, and lists only apps the owner let in', async () => {
    const { client, access_token, refresh_token } = await claimAndSignIn();
    await register();
    const local = (method: 'GET' | 'DELETE', url: string) => harness.app.inject({ method, url, headers: { authorization: 'Bearer local-token' } });
    expect((await local('GET', '/v1/remote')).json()).toMatchObject({ apps: [{ id: client, name: 'Claude', createdAt: expect.any(String) }] });
    expect((await local('DELETE', `/v1/remote/apps/${client}`)).json()).toMatchObject({ apps: [] });
    expect((await pub('POST', '/mcp', { token: access_token, json: {} })).statusCode).toBe(401);
    expect((await pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token, client_id: client } })).statusCode).toBe(401);
    const o = (await harness.app.inject({ method: 'GET', url: '/v1/overview', headers: { authorization: 'Bearer local-token' } })).json() as { remote?: unknown };
    expect(o.remote).toEqual({ on: true, publicUrl: ORIGIN, apps: 0 });
  });

  it('keeps a flood from anyone else off an approval in flight, and off an app already signed in', async () => {
    const { client, refresh_token } = await claimAndSignIn();
    const ask = { owner: remote.store.current.owner!.id, client: 'c1', app: 'Claude', tool: 'shell', summary: '$ ls', detail: 'command: ls', digest: 'd9' };
    const id = new URL((remote.approvals.check(ask) as { link: string }).link).searchParams.get('id')!;
    for (let i = 0; i < LIMITS.signIn; i++) await pub('GET', '/oauth/authorize?client_id=nobody');
    expect((await pub('GET', '/oauth/authorize?client_id=nobody')).statusCode).toBe(429);
    expect((await pub('GET', `/oauth/approve?id=${id}`)).statusCode).toBe(200);
    for (let i = 0; i < LIMITS.tokens; i++) await pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'nobody' } });
    expect((await pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'nobody' } })).statusCode).toBe(429);
    expect((await pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token, client_id: client } })).statusCode).toBe(200);
  });

  it('goes by the port a request came in on, never its Host', async () => {
    const local = (url: string, headers: Record<string, string>) => harness.app.inject({ method: 'GET', url, headers: { authorization: 'Bearer local-token', ...headers } });
    // Naming the public host on the API's port is not the public URL.
    expect((await local('/.well-known/oauth-authorization-server', { host: RP })).statusCode).toBe(404);
    expect((await local('/v1/computers', { host: RP })).statusCode).toBe(403);
    // Through the public port with a Host of 127.0.0.1: the remote paths, and nothing else.
    expect((await local('/v1/computers', { host: '127.0.0.1:7377', [PUBLIC_HEADER]: remote.mark })).statusCode).toBe(404);
    expect((await local('/.well-known/oauth-authorization-server', { host: '127.0.0.1:7377', [PUBLIC_HEADER]: remote.mark })).statusCode).toBe(200);
    // A mark that is not this process's own is no mark at all.
    expect((await local('/v1/computers', { [PUBLIC_HEADER]: 'a-guess' })).statusCode).toBe(200);
  });

  it('sends nothing back before the owner signs in, and warns of a return address it does not know', async () => {
    const reg = await pub('POST', '/oauth/register', { json: { redirect_uris: ['https://evil.example/cb'], client_name: 'Claude' } });
    const client = (reg.json() as { client_id: string }).client_id;
    const q = (extra: Record<string, string>) =>
      `/oauth/authorize?${new URLSearchParams({ client_id: client, redirect_uri: 'https://evil.example/cb', response_type: 'code', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', ...extra })}`;
    const bad = await pub('GET', q({ response_type: 'token' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.headers.location).toBeUndefined();
    const page = await pub('GET', q({}));
    expect(page.body).toContain('"knownReturn":false');
    expect(page.body).toContain('If someone sent you this link, deny it.');
    expect((await authorize(await register(), 'v'.repeat(43))).page.body).toContain('"knownReturn":true');
    // Perplexity's documented return address is one Husk knows too.
    const PPLX = 'https://www.perplexity.ai/rest/connections/oauth_callback';
    const pplx = (await pub('POST', '/oauth/register', { json: { redirect_uris: [PPLX], client_name: 'Perplexity' } })).json() as { client_id: string };
    const pq = new URLSearchParams({ client_id: pplx.client_id, redirect_uri: PPLX, response_type: 'code', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' });
    expect((await pub('GET', `/oauth/authorize?${pq}`)).body).toContain('"knownReturn":true');
    const meta = (await pub('GET', '/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('opens only links minted for a remote chat under the public URL', async () => {
    const { device } = await claimAndSignIn();
    const owner = await ownerSessionOf(device);
    const local = (url: string, payload: object) => harness.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer local-token' }, payload });
    const computer = (await local('/v1/computers', {})).json() as { id: string };
    const mine = (await local(`/v1/computers/${computer.id}/link`, {})).json() as { token: string };
    expect((await pub('GET', '/v1/scoped/computer', { token: mine.token, owner })).statusCode).toBe(401);
    const theirs = (await local(`/v1/computers/${computer.id}/link`, { public: true })).json() as { token: string };
    expect((await pub('GET', '/v1/scoped/computer', { token: theirs.token, owner })).statusCode).toBe(200);
    // On this machine, both open it as before.
    const here = (token: string) => harness.app.inject({ method: 'GET', url: '/v1/scoped/computer', headers: { authorization: `Bearer ${token}` } });
    expect((await here(mine.token)).statusCode).toBe(200);
    expect((await here(theirs.token)).statusCode).toBe(200);
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
    expect(plain.statusCode).toBe(400);
    expect(plain.headers.location).toBeUndefined();
    expect(plain.body).toContain('PKCE');
    expect((await pub('POST', '/oauth/register', { json: { redirect_uris: ['http://evil.example/cb'] } })).statusCode).toBe(400);
  });

  it('lets the owner approve one call with the passkey, at a page under the public URL', async () => {
    const { device } = await claimAndSignIn();
    const ask = { owner: remote.store.current.owner!.id, client: 'c1', app: 'Claude', tool: 'shell', summary: '$ make deploy', detail: 'command: make deploy\ncwd: /work/site', digest: 'd1' };
    const first = remote.approvals.check(ask);
    expect(first).toMatchObject({ ok: false, state: 'asked' });
    const id = new URL((first as { link: string }).link).searchParams.get('id')!;
    expect(remote.approvals.check(ask)).toMatchObject({ ok: false, state: 'waiting' });
    const page = await pub('GET', `/oauth/approve?id=${id}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('$ make deploy');
    // Every argument, not only the line, and what the hour would cover.
    expect(page.body).toContain('cwd: /work/site');
    expect(page.body).toContain('on any of its computers');
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
    const ask = { owner: remote.store.current.owner!.id, client: 'c1', app: 'Claude', tool: 'browser_type', summary: 'type 8 characters into e12', detail: 'ref: e12\ntext: hunter22', digest: 'd2' };
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

  it('opens a handoff link under the public URL only with its own token and the owner’s passkey', async () => {
    const { device } = await claimAndSignIn();
    const computer = (await here('POST', '/v1/computers', {})).json() as { id: string };
    const handoff = (await here('POST', `/v1/computers/${computer.id}/handoffs`, { reason: 'Sign in to your bank.', public: true })).json() as { handoffId: string; token: string };
    // The chat holds the link too, so alone it opens nothing.
    const alone = await pub('GET', `/v1/handoffs/${handoff.handoffId}`, { token: handoff.token });
    expect(alone.statusCode).toBe(401);
    expect(alone.json()).toMatchObject({ error: { details: { passkey: true } } });
    const owner = await ownerSessionOf(device);
    expect((await pub('GET', `/v1/handoffs/${handoff.handoffId}`, { token: handoff.token, owner })).statusCode).toBe(200);
    // Not this machine's own token, not a token in the URL, and not another route.
    expect((await pub('GET', `/v1/handoffs/${handoff.handoffId}`, { token: 'local-token', owner })).statusCode).toBe(401);
    expect((await pub('GET', `/v1/handoffs/${handoff.handoffId}?token=${handoff.token}`, { owner })).statusCode).toBe(401);
    expect((await pub('GET', '/v1/handoffs', { token: handoff.token, owner })).statusCode).toBe(404);
  });

  it('lets nobody act through a link without the owner’s passkey, which is good for one try a challenge', async () => {
    const { device } = await claimAndSignIn();
    const computer = (await here('POST', '/v1/computers', {})).json() as { id: string };
    const { token } = (await here('POST', `/v1/computers/${computer.id}/link`, { public: true })).json() as { token: string };
    expect((await pub('POST', '/v1/scoped/computer/takeover', { token, origin: ORIGIN, json: {} })).statusCode).toBe(401);
    // Another device's passkey gets no session, and its challenge is spent.
    const step = (await pub('POST', '/oauth/link/start', { json: {}, origin: ORIGIN })).json() as { id: string; publicKey: { challenge: string } };
    expect((await pub('POST', '/oauth/link', { json: { id: step.id, credential: authenticator().get(step.publicKey.challenge) }, origin: ORIGIN })).statusCode).toBe(403);
    expect((await pub('POST', '/oauth/link', { json: { id: step.id, credential: device.get(step.publicKey.challenge) }, origin: ORIGIN })).statusCode).toBe(400);
    const owner = await ownerSessionOf(device);
    expect((await pub('POST', '/v1/scoped/computer/takeover', { token, owner, origin: ORIGIN, json: {} })).statusCode).toBe(201);
    expect((await pub('POST', '/v1/scoped/computer/takeover', { token, owner: 'a-guess', origin: ORIGIN, json: {} })).statusCode).toBe(401);
  });

  it('ends the links a remote chat was given when its app signs out, and every link and owner session when remote access goes off', async () => {
    const { client, device } = await claimAndSignIn();
    const computer = (await here('POST', '/v1/computers', {})).json() as { id: string };
    const mint = async (holder: string) => ((await here('POST', `/v1/computers/${computer.id}/link`, { public: true, holder })).json() as { token: string }).token;
    const opens = async (token: string, owner: string) => (await pub('GET', '/v1/scoped/computer', { token, owner })).statusCode;
    let owner = await ownerSessionOf(device);
    const theirs = await mint(client);
    const another = await mint('another-app');
    expect(await opens(theirs, owner)).toBe(200);
    await here('DELETE', `/v1/remote/apps/${client}`);
    expect(await opens(theirs, owner)).toBe(401);
    expect(await opens(another, owner)).toBe(200);
    await here('POST', '/v1/remote/off');
    await here('POST', '/v1/remote/on');
    const after = await pub('GET', '/v1/scoped/computer', { token: another, owner });
    expect(after.json()).toMatchObject({ error: { details: { passkey: true } } });
    owner = await ownerSessionOf(device);
    expect(await opens(another, owner)).toBe(401);
  });

  it('ends the access tokens of a family a reused refresh token ended, not at the end of their hour', async () => {
    const { client, refresh_token } = await claimAndSignIn();
    const refresh = (token: string) => pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: token, client_id: client } });
    const copy = (await refresh(refresh_token)).json() as { access_token: string };
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await pub('POST', '/mcp', { token: copy.access_token, json: list })).statusCode).toBe(200);
    // The first token used again: the family ends, and so does the access token minted in it.
    await refresh(refresh_token);
    expect((await pub('POST', '/mcp', { token: copy.access_token, json: list })).statusCode).toBe(401);
  });

  it('ends a sign-in that typed the old claim code once a new one is made', async () => {
    const client = await register();
    const { request } = await authorize(client, 'v'.repeat(43));
    const options = (await pub('POST', '/oauth/claim', { json: { request, code: claim }, origin: ORIGIN })).json() as { publicKey: { challenge: string } };
    await here('POST', '/v1/remote/claim');
    const made = await pub('POST', '/oauth/passkey', { json: { request, credential: authenticator().create(options.publicKey.challenge) }, origin: ORIGIN });
    expect(made.statusCode).toBe(403);
    expect(remote.store.current.owner).toBeUndefined();
  });

  it('keeps no idempotency record for the public URL, reads no body before the token, and keeps sign-in bodies small', async () => {
    const reg = () => pub('POST', '/oauth/register', { json: { redirect_uris: [CALLBACK] }, headers: { 'idempotency-key': 'k1' } });
    const first = (await reg()).json() as { client_id: string };
    const again = await reg();
    expect(again.headers['idempotency-replayed']).toBeUndefined();
    expect((again.json() as { client_id: string }).client_id).not.toBe(first.client_id);
    // A body without a good token is not read: the answer is the 401, not a parse error.
    const noToken = await pub('POST', '/mcp', { payload: Buffer.alloc(2 * 1024 * 1024, 0x7b), headers: { 'content-type': 'application/json' } });
    expect(noToken.statusCode).toBe(401);
    const big = await pub('POST', '/oauth/register', { payload: Buffer.from(JSON.stringify({ redirect_uris: [CALLBACK], client_name: 'x'.repeat(100 * 1024) })), headers: { 'content-type': 'application/json' } });
    expect(big.statusCode).toBe(413);
  });

  it('takes no app id from the object prototype, and says only that it is up under the public URL', async () => {
    for (const id of ['__proto__', 'constructor', 'toString']) {
      expect((await pub('GET', `/oauth/authorize?client_id=${id}&redirect_uri=x`)).statusCode).toBe(400);
      expect((await pub('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: 'x', client_id: id } })).statusCode).toBe(401);
    }
    expect((await pub('GET', '/health')).json()).toEqual({ ok: true });
    expect((await harness.app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ ok: true, version: expect.any(String) });
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
