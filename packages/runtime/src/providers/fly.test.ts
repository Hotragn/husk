import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HuskError } from '@husk/core';
import { FLY_API, FlyProvider, buildMachineConfig, declaredPorts, flyError } from './fly.js';

/**
 * No token, no app, no network.
 *
 * Every request is shaped here and asserted against a fake fetch, because the
 * alternative -- finding out the guest block is wrong -- costs money and takes
 * a round trip to Fly to discover.
 */

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Canned {
  status?: number;
  body?: unknown;
  /** Raw text, when the point is that it is not JSON. */
  text?: string;
}

function fakeFetch(responses: Canned[] | ((url: string, init: RequestInit) => Canned)) {
  const calls: Recorded[] = [];
  let i = 0;
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const canned = typeof responses === 'function' ? responses(url, init) : (responses[i++] ?? { status: 200, body: {} });
    const text = canned.text ?? JSON.stringify(canned.body ?? {});
    const status = canned.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

const ENV = { FLY_API_TOKEN: 'fo1_secret', HUSK_FLY_APP: 'husk-test', HUSK_FLY_REGION: 'iad' };

let home: string;
let previousHome: string | undefined;

beforeAll(async () => {
  // create() persists a record; keep it out of the developer's real ~/.husk.
  previousHome = process.env.HUSK_HOME;
  home = await mkdtemp(join(tmpdir(), 'husk-fly-test-'));
  process.env.HUSK_HOME = home;
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.HUSK_HOME;
  else process.env.HUSK_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe('FlyProvider.isAvailable', () => {
  it('is the lowest priority, because it is the only one that spends money', () => {
    expect(new FlyProvider().priority).toBe(14);
  });

  it('asks for a token before it asks for anything else', async () => {
    const { fn, calls } = fakeFetch([]);
    const a = await new FlyProvider({ fetch: fn, env: {} }).isAvailable();
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/FLY_API_TOKEN/);
    expect(a.hint).toMatch(/fly auth token/);
    // No token means no request: probing must not leak an unauthenticated call.
    expect(calls).toHaveLength(0);
  });

  it('distinguishes "no app" from "no token"', async () => {
    const { fn, calls } = fakeFetch([]);
    const a = await new FlyProvider({ fetch: fn, env: { FLY_API_TOKEN: 't' } }).isAvailable();
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/no app is configured/);
    expect(a.hint).toMatch(/fly apps create/);
    expect(calls).toHaveLength(0);
  });

  it('checks the app itself, with the token as a bearer', async () => {
    const { fn, calls } = fakeFetch([{ body: { name: 'husk-test', organization: { slug: 'acme' } } }]);
    const a = await new FlyProvider({ fetch: fn, env: ENV }).isAvailable();
    expect(a.available).toBe(true);
    expect(a.isolated).toBe(true);
    expect(a.version).toContain('husk-test');
    expect(a.version).toContain('acme');
    expect(calls[0]?.url).toBe(`${FLY_API}/apps/husk-test`);
    expect(calls[0]?.headers.Authorization).toBe('Bearer fo1_secret');
  });

  it('turns a 401 into "the token is wrong", not "fly is down"', async () => {
    const { fn } = fakeFetch([{ status: 401, body: { error: 'unauthorized' } }]);
    const a = await new FlyProvider({ fetch: fn, env: ENV }).isAvailable();
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/rejected the token/);
    expect(a.hint).toMatch(/fly auth token/);
  });

  it('turns a 404 into "that app does not exist"', async () => {
    const { fn } = fakeFetch([{ status: 404, body: { error: 'app not found' } }]);
    const a = await new FlyProvider({ fetch: fn, env: ENV }).isAvailable();
    expect(a.available).toBe(false);
    expect(a.hint).toMatch(/husk-test/);
  });

  it('never throws, whatever the network does', async () => {
    const fn = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.machines.dev');
    }) as unknown as typeof globalThis.fetch;
    const a = await new FlyProvider({ fetch: fn, env: ENV }).isAvailable();
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/cannot reach the fly api/);
    expect(a.hint).toBeTruthy();
  });

  it('honours an override base url, so a test never touches the real api', async () => {
    const { fn, calls } = fakeFetch([{ body: { name: 'x' } }]);
    await new FlyProvider({ fetch: fn, env: ENV, baseUrl: 'http://127.0.0.1:1/v1' }).isAvailable();
    expect(calls[0]?.url).toBe('http://127.0.0.1:1/v1/apps/husk-test');
  });
});

describe('buildMachineConfig', () => {
  it('keeps the machine alive instead of running the image entrypoint', () => {
    const cfg = buildMachineConfig({}, 'debian:bookworm-slim', '/work') as Record<string, any>;
    expect(cfg.init.cmd).toEqual(['/bin/sh', '-c', 'mkdir -p /work && exec sleep infinity']);
    expect(cfg.restart).toEqual({ policy: 'no' });
  });

  it('asks for a shared guest sized from the spec', () => {
    const cfg = buildMachineConfig({ cpus: 2, memoryMb: 2048 }, 'img', '/work') as Record<string, any>;
    expect(cfg.guest).toEqual({ cpu_kind: 'shared', cpus: 2, memory_mb: 2048 });
  });

  it('rounds memory up to the 256MB step fly requires', () => {
    const round = (mb: number) => (buildMachineConfig({ memoryMb: mb }, 'i', '/work') as any).guest.memory_mb;
    expect(round(100)).toBe(256);
    expect(round(300)).toBe(512);
    expect(round(1000)).toBe(1024);
  });

  it('defaults to one shared cpu and a gigabyte', () => {
    const guest = (buildMachineConfig({}, 'i', '/work') as any).guest;
    expect(guest).toEqual({ cpu_kind: 'shared', cpus: 1, memory_mb: 1024 });
  });

  it('tags the machine so list() can tell ours from the rest of the app', () => {
    const cfg = buildMachineConfig({ labels: { 'husk.id': 'cmp_9' } }, 'i', '/work') as any;
    expect(cfg.metadata).toEqual({ 'husk.id': 'cmp_9', 'husk.provider': 'fly' });
  });

  it('declares no services unless ports were asked for', () => {
    expect((buildMachineConfig({}, 'i', '/work') as any).services).toBeUndefined();
  });

  it('publishes declared ports behind fly http and tls handlers', () => {
    const cfg = buildMachineConfig({ labels: { 'husk.fly.ports': '8000' } }, 'i', '/work') as any;
    expect(cfg.services).toEqual([
      {
        protocol: 'tcp',
        internal_port: 8000,
        ports: [
          { port: 80, handlers: ['http'] },
          { port: 443, handlers: ['tls', 'http'] },
        ],
      },
    ]);
  });
});

describe('declaredPorts', () => {
  it('reads a comma list and ignores junk', () => {
    expect(declaredPorts({ labels: { 'husk.fly.ports': '8000, 3000 ,nope,0,70000' } })).toEqual([8000, 3000]);
  });

  it('is empty when nothing was declared', () => {
    expect(declaredPorts({})).toEqual([]);
  });
});

describe('flyError', () => {
  const cases: Array<[number, string, RegExp]> = [
    [401, 'E_NO_CREDENTIALS', /rejected the token/],
    [403, 'E_NO_CREDENTIALS', /rejected the token/],
    [404, 'E_COMPUTER_NOT_FOUND', /404/],
    [422, 'E_COMPUTER_FAILED', /refused the machine config/],
    [429, 'E_QUOTA', /rate limiting/],
    [500, 'E_COMPUTER_FAILED', /fly api error 500/],
    [418, 'E_COMPUTER_FAILED', /returned 418/],
  ];

  for (const [status, code, message] of cases) {
    it(`maps ${status} to ${code}`, () => {
      const e = flyError(status, JSON.stringify({ error: 'boom' }), 'husk-test', 'GET', '/apps/husk-test');
      expect(e.code).toBe(code);
      expect(e.message).toMatch(message);
      expect(e.hint).toBeTruthy();
    });
  }

  it('surfaces fly\'s own error text', () => {
    const e = flyError(422, JSON.stringify({ error: 'unknown region xyz' }), 'a', 'POST', '/p');
    expect(e.message).toContain('unknown region xyz');
  });

  it('survives a non-JSON body, which is what a proxy returns', () => {
    const e = flyError(502, '<html>bad gateway</html>', 'a', 'GET', '/p');
    expect(e.code).toBe('E_COMPUTER_FAILED');
    expect(e.message).toContain('bad gateway');
  });
});

describe('create', () => {
  let created: ReturnType<typeof fakeFetch>;

  beforeEach(() => {
    created = fakeFetch((url) => {
      if (url.endsWith('/machines')) return { body: { id: '17811943c34d89', state: 'created' } };
      return { body: { ok: true } };
    });
  });

  it('posts the machine to the app and waits for it to start', async () => {
    const provider = new FlyProvider({ fetch: created.fn, env: ENV });
    const computer = await provider.create({ flavor: 'python', cpus: 2, memoryMb: 1024 });

    const post = created.calls[0]!;
    expect(post.method).toBe('POST');
    expect(post.url).toBe(`${FLY_API}/apps/husk-test/machines`);
    expect(post.headers['Content-Type']).toBe('application/json');

    const body = post.body as Record<string, any>;
    expect(body.region).toBe('iad');
    expect(body.name).toMatch(/^husk-/);
    expect(body.config.image).toBe('python:3.12-slim');
    expect(body.config.guest).toEqual({ cpu_kind: 'shared', cpus: 2, memory_mb: 1024 });
    expect(body.config.env.HUSK).toBe('1');

    const wait = created.calls[1]!;
    expect(wait.method).toBe('GET');
    expect(wait.url).toBe(`${FLY_API}/apps/husk-test/machines/17811943c34d89/wait?state=started&timeout=60`);

    expect(computer.info.nativeId).toBe('17811943c34d89');
    expect(computer.info.state).toBe('running');
    expect(computer.info.provider).toBe('fly');
  });

  it('honours an explicit image over the flavor', async () => {
    const provider = new FlyProvider({ fetch: created.fn, env: ENV });
    await provider.create({ image: 'alpine:3.20' });
    expect((created.calls[0]!.body as any).config.image).toBe('alpine:3.20');
  });

  it('destroys a machine that never came up, rather than billing for it', async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith('/machines')) return { body: { id: 'm1' } };
      if (url.includes('/wait')) return { status: 500, body: { error: 'timeout waiting for machine' } };
      return { body: {} };
    });
    const provider = new FlyProvider({ fetch: f.fn, env: ENV });
    await expect(provider.create({})).rejects.toThrow(/fly api error 500/);
    const del = f.calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe(`${FLY_API}/apps/husk-test/machines/m1?force=true`);
  });

  it('refuses to create without a token, with the fix in the message', async () => {
    const provider = new FlyProvider({ fetch: created.fn, env: {} });
    await expect(provider.create({})).rejects.toMatchObject({ code: 'E_NO_CREDENTIALS' });
  });
});

describe('exec', () => {
  async function machine(responses: Parameters<typeof fakeFetch>[0]) {
    const boot = fakeFetch((url) => (url.endsWith('/machines') ? { body: { id: 'm1' } } : { body: {} }));
    const provider = new FlyProvider({ fetch: boot.fn, env: ENV });
    const computer = await provider.create({});
    const f = fakeFetch(responses);
    // Swap the transport now that the machine exists, so exec calls are alone.
    (computer as unknown as { cfg: { fetch: unknown } }).cfg.fetch = f.fn;
    return { computer, calls: f.calls };
  }

  it('posts to the machine exec endpoint with a wrapped shell command', async () => {
    const { computer, calls } = await machine([{ body: { exit_code: 0, stdout: 'hi\n', stderr: '' } }]);
    const r = await computer.exec({ cmd: 'echo hi', timeoutSec: 30 });

    expect(calls[0]?.url).toBe(`${FLY_API}/apps/husk-test/machines/m1/exec`);
    const body = calls[0]?.body as { command: string[]; timeout: number };
    expect(body.timeout).toBe(30);
    expect(body.command[0]).toBe('/bin/sh');
    expect(body.command[1]).toBe('-c');
    // shellQuote leaves a path that needs no quoting alone.
    expect(body.command[2]).toContain('cd /work &&');
    expect(body.command[2]).toContain("/bin/sh -c 'echo hi'");
    expect(r).toMatchObject({ exitCode: 0, stdout: 'hi\n', timedOut: false });
  });

  it('quotes an argv array rather than joining it into a shell string', async () => {
    const { computer, calls } = await machine([{ body: { exit_code: 0 } }]);
    await computer.exec({ cmd: ['python', '-c', 'print("a b")'] });
    expect((calls[0]?.body as any).command[2]).toContain(`'python -c '\\''print("a b")'\\'''`);
  });

  it('passes the cwd and env the caller asked for', async () => {
    const { computer, calls } = await machine([{ body: { exit_code: 0 } }]);
    await computer.exec({ cmd: 'pwd', cwd: '/work/sub', env: { TOKENLESS: 'yes' } });
    const script = (calls[0]?.body as any).command[2] as string;
    expect(script).toContain('cd /work/sub &&');
    expect(script).toContain('TOKENLESS=yes');
  });

  it('reports a non-zero exit code instead of throwing', async () => {
    const { computer } = await machine([{ body: { exit_code: 2, stderr: 'nope' } }]);
    await expect(computer.exec({ cmd: 'false' })).resolves.toMatchObject({ exitCode: 2, stderr: 'nope' });
  });

  it('turns a signal into the shell convention', async () => {
    const { computer } = await machine([{ body: { exit_signal: 9 } }]);
    await expect(computer.exec({ cmd: 'x' })).resolves.toMatchObject({ exitCode: 137 });
  });

  it('applies the command policy before it spends a request', async () => {
    const { computer, calls } = await machine([{ body: { exit_code: 0 } }]);
    await expect(computer.exec({ cmd: 'rm -rf /' })).rejects.toMatchObject({ code: 'E_EXEC_DENIED' });
    expect(calls).toHaveLength(0);
  });

  it('says plainly that the exec endpoint has no stdin', async () => {
    const { computer } = await machine([{ body: { exit_code: 0 } }]);
    await expect(computer.exec({ cmd: 'cat', stdin: 'x' })).rejects.toThrow(/cannot accept stdin/);
  });

  it('refuses to expose a port that was never published', async () => {
    const { computer } = await machine([]);
    await expect(computer.exposePort(8000)).rejects.toThrow(/was not published/);
    try {
      await computer.exposePort(8000);
    } catch (e) {
      expect((e as HuskError).hint).toContain('husk.fly.ports');
    }
  });
});
