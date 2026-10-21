import { HUSK_VERSION, createLogger } from '@husk-ai/core';
import type { DaemonRecord } from '@husk-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonUnreachable, connectDaemon } from './daemon.js';

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
});
