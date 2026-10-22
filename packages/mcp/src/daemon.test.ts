import { HUSK_VERSION, createLogger } from '@husk-ai/core';
import type { DaemonRecord } from '@husk-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonUnreachable, RunLocally, connectDaemon, newer } from './daemon.js';

const log = createLogger({ level: 'silent' });
const record = (version = HUSK_VERSION): DaemonRecord => ({
  url: 'http://127.0.0.1:7377',
  token: 'tok',
  pid: 1,
  version,
  startedAt: '',
});

/** A fetch that answers /health with the given version and records tool calls. */
function fakeFetch(version: string, onTool?: (init: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, version }), { status: 200 });
    return onTool ? onTool(init ?? {}) : new Response('{}', { status: 500 });
  }) as typeof fetch;
  return Object.assign(impl, { calls });
}

// The suite runs with HUSK_DAEMON=off so nothing else starts one; these tests opt back in.
beforeEach(() => {
  delete process.env.HUSK_DAEMON;
});
afterEach(() => {
  process.env.HUSK_DAEMON = 'off';
});

describe('connectDaemon', () => {
  it('uses a running daemon of the same version, and sends its token', async () => {
    const f = fakeFetch(HUSK_VERSION, () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ran' }] })));
    const d = await connectDaemon({ log, read: () => record(), fetchImpl: f, launch: () => { throw new Error('must not launch'); } });
    expect(d?.url).toBe('http://127.0.0.1:7377');
    const result = await d!.callTool('cmp_1', 'shell', { command: 'ls' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'ran' });
    const tool = f.calls.find((c) => c.url.includes('/tools/shell'))!;
    expect((tool.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(tool.init!.body))).toEqual({ args: { command: 'ls' }, via: 'mcp' });
  });

  it('starts one when none answers, and waits for it', async () => {
    let launched = false;
    const d = await connectDaemon({
      log,
      read: () => (launched ? record() : undefined),
      launch: () => { launched = true; },
      fetchImpl: fakeFetch(HUSK_VERSION),
      waitMs: 5_000,
    });
    expect(launched).toBe(true);
    expect(d).toBeDefined();
  });

  it('runs in-process rather than use a daemon of another version', async () => {
    let launched = false;
    const d = await connectDaemon({ log, read: () => record('0.0.1'), fetchImpl: fakeFetch('0.0.1'), launch: () => { launched = true; } });
    expect(d).toBeUndefined();
    expect(launched).toBe(false);
  });

  it('gives up and runs in-process when a started daemon never answers', async () => {
    const d = await connectDaemon({ log, read: () => undefined, launch: () => {}, fetchImpl: fakeFetch(HUSK_VERSION), waitMs: 300 });
    expect(d).toBeUndefined();
  });

  it('is off when HUSK_DAEMON=off', async () => {
    process.env.HUSK_DAEMON = 'off';
    expect(await connectDaemon({ log, read: () => record(), fetchImpl: fakeFetch(HUSK_VERSION) })).toBeUndefined();
  });

  it('says a refused connection is safe to run locally, and returns a server error as a tool error', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    let mode: 'refuse' | 'error' = 'refuse';
    const f = fakeFetch(HUSK_VERSION, () => {
      if (mode === 'refuse') throw refused;
      return new Response(JSON.stringify({ error: { message: 'no computer', hint: 'start it' } }), { status: 404 });
    });
    const d = (await connectDaemon({ log, read: () => record(), fetchImpl: f }))!;
    await expect(d.callTool('cmp_1', 'shell', {})).rejects.toBeInstanceOf(DaemonUnreachable);
    mode = 'error';
    expect(await d.callTool('cmp_1', 'shell', {})).toEqual({ isError: true, content: [{ type: 'text', text: 'no computer\nstart it' }] });
  });

  it('never makes a link token out of a 404 or an empty answer', async () => {
    let answer = new Response(JSON.stringify({ error: { code: 'E_COMPUTER_NOT_FOUND', message: 'no' } }), { status: 404 });
    const d = (await connectDaemon({ log, read: () => record(), fetchImpl: fakeFetch(HUSK_VERSION, () => answer) }))!;
    await expect(d.linkToken('cmp_1')).rejects.toBeInstanceOf(RunLocally);
    answer = new Response('{}', { status: 200 });
    await expect(d.linkToken('cmp_1')).rejects.toThrow('no link token');
    answer = new Response(JSON.stringify({ token: 'abc' }), { status: 200 });
    expect(await d.linkToken('cmp_1')).toBe('abc');
  });

  it('picks up a restarted daemon (new token) and retries once, since a 401 means nothing ran', async () => {
    let current = record();
    const calls: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response(JSON.stringify({ version: HUSK_VERSION }), { status: 200 });
      const auth = (init?.headers as Record<string, string>).authorization;
      calls.push(auth ?? "");
      if (auth !== `Bearer ${current.token}`) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ran' }] }), { status: 200 });
    }) as typeof fetch;
    const d = (await connectDaemon({ log, read: () => current, fetchImpl: f }))!;
    current = { ...record(), token: 'new-token', pid: 2 };
    const r = await d.callTool('cmp_1', 'shell', {});
    expect(r.content[0]).toEqual({ type: 'text', text: 'ran' });
    expect(calls).toEqual(['Bearer tok', 'Bearer new-token']);
  });

  it('asks an older daemon to step aside, then starts this version', async () => {
    let old = true;
    let launched = false;
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/shutdown')) {
        old = false;
        return new Response('{}', { status: 202 });
      }
      if (url.endsWith('/health')) {
        if (old) return new Response(JSON.stringify({ version: '0.0.1' }), { status: 200 });
        if (!launched) throw Object.assign(new TypeError('down'), { cause: { code: 'ECONNREFUSED' } });
        return new Response(JSON.stringify({ version: HUSK_VERSION }), { status: 200 });
      }
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    const d = await connectDaemon({
      log,
      read: () => (old ? record('0.0.1') : launched ? record() : undefined),
      fetchImpl: f,
      launch: () => {
        launched = true;
      },
      waitMs: 3_000,
    });
    expect(launched).toBe(true);
    expect(d).toBeDefined();
  });

  it('compares versions numerically', () => {
    expect(newer('0.10.0', '0.9.9')).toBe(true);
    expect(newer('0.2.0', '0.2.0')).toBe(false);
    expect(newer('0.1.4', '0.2.0')).toBe(false);
  });
});
