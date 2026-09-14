/**
 * Transport-level unit tests.
 *
 * These cover the things a live server cannot be made to do on demand: a dead
 * socket, a proxy answering HTML, an aborted signal, a timer that must not be
 * armed. Everything about *which route a method calls and what it returns* is
 * asserted in `contract.test.ts` against the real server -- a stubbed `fetch`
 * agrees with whatever the SDK believes, which is exactly how this package
 * shipped pointing at twelve routes that did not exist.
 */
import { describe, expect, it, vi } from 'vitest';
import { HuskError } from '@husk/core';
import { HuskClient } from './client.js';
import type { FetchLike } from './http.js';

interface Call {
  url: string;
  init: RequestInit;
}

function stub(handler: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('url building', () => {
  it('defaults to the loopback control plane and strips a trailing slash', () => {
    const { fetch } = stub(() => json({}));
    expect(new HuskClient({ fetch }).baseUrl).toBe('http://127.0.0.1:7377');
    expect(new HuskClient({ fetch, baseUrl: 'http://box:9000/' }).baseUrl).toBe('http://box:9000');
  });

  it('encodes ids so a name cannot forge a path segment', async () => {
    const { fetch, calls } = stub(() => json({}));
    await new HuskClient({ fetch }).computers.get('a/b');
    expect(calls[0]!.url).toBe('http://127.0.0.1:7377/v1/computers/a%2Fb');
  });

  it('drops undefined query parameters instead of sending the string "undefined"', async () => {
    const { fetch, calls } = stub(() => json({ runs: [] }));
    await new HuskClient({ fetch }).runs.list({ husk: 'bot' });
    expect(calls[0]!.url).toBe('http://127.0.0.1:7377/v1/runs?husk=bot');
  });

  it('turns the base url into a ws url and carries the token in the query', () => {
    const { fetch } = stub(() => json({}));
    const plain = new HuskClient({ fetch, baseUrl: 'http://box:9000' });
    expect(plain.http.wsUrl('/v1/events')).toBe('ws://box:9000/v1/events');
    const tls = new HuskClient({ fetch, baseUrl: 'https://box', token: 't' });
    expect(tls.http.wsUrl('/v1/events')).toBe('wss://box/v1/events?token=t');
  });
});

describe('headers', () => {
  it('sends a bearer token when one is configured', async () => {
    const { fetch, calls } = stub(() => json({ computers: [] }));
    await new HuskClient({ fetch, token: 'tok' }).computers.list();
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('omits content-type when there is no body', async () => {
    const { fetch, calls } = stub(() => json({ computers: [] }));
    await new HuskClient({ fetch }).computers.list();
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('asks for event-stream on streaming calls', async () => {
    const { fetch, calls } = stub(() => sse('event: done\ndata: {}\n\n'));
    const it = new HuskClient({ fetch }).computers.execStream('c1', { cmd: 'ls' });
    for await (const _ of it) void _;
    expect((calls[0]!.init.headers as Record<string, string>).accept).toBe('text/event-stream');
  });

  it('sends file writes as bytes, not as a JSON-encoded string', async () => {
    const { fetch, calls } = stub(() => new Response(null, { status: 204 }));
    await new HuskClient({ fetch }).computers.writeFile('c1', '/work/a.bin', new Uint8Array([1, 2, 3]));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/octet-stream');
    expect(calls[0]!.url).toBe('http://127.0.0.1:7377/v1/computers/c1/fs/write?path=%2Fwork%2Fa.bin');
    expect(new Uint8Array(calls[0]!.init.body as ArrayBufferView as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('error mapping', () => {
  it('rebuilds the HuskError the server threw, code and hint intact', async () => {
    const { fetch } = stub(() =>
      json({ error: { code: 'E_QUOTA', message: 'already running 8 computers', hint: 'husk rm one' } }, 429),
    );
    const err = await new HuskClient({ fetch }).computers.create().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HuskError);
    expect(err).toMatchObject({ code: 'E_QUOTA', message: 'already running 8 computers', hint: 'husk rm one' });
  });

  it('round-trips a server-only code instead of collapsing it onto a core one', async () => {
    const { fetch } = stub(() => json({ error: { code: 'E_HUSK_NOT_FOUND', message: 'no husk with id bot' } }, 404));
    const err = (await new HuskClient({ fetch }).husks.get('bot').catch((e: unknown) => e)) as HuskError;
    expect(err.code).toBe('E_HUSK_NOT_FOUND');
    expect(err.details).not.toHaveProperty('unrecognizedCode');
  });

  it('falls back to a status-derived code when the body is not ours', async () => {
    const { fetch } = stub(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const err = (await new HuskClient({ fetch }).health().catch((e: unknown) => e)) as HuskError;
    expect(err.code).toBe('E_INTERNAL');
    expect(err.details).toMatchObject({ inferredFromStatus: true });
    expect(err.hint).toContain('husk serve');
  });

  it('does not invent E_COMPUTER_NOT_FOUND for a 404 that named no resource', async () => {
    const { fetch } = stub(() => json({ error: {} }, 404));
    const err = (await new HuskClient({ fetch }).computers.get('nope').catch((e: unknown) => e)) as HuskError;
    expect(err.code).toBe('E_ROUTE_NOT_FOUND');
    expect(err.details).toMatchObject({ inferredFromStatus: true });
    expect(err.hint).toContain('husk ps');
  });

  it('passes an unrecognised code through verbatim and flags it', async () => {
    const { fetch } = stub(() => json({ error: { code: 'E_FROM_THE_FUTURE', message: 'x' } }, 500));
    const err = (await new HuskClient({ fetch }).health().catch((e: unknown) => e)) as HuskError;
    // Substituting a code we do recognise would read as authoritative and be wrong.
    expect(err.code).toBe('E_FROM_THE_FUTURE');
    expect(err.details?.unrecognizedCode).toBe(true);
  });

  it('turns a dead control plane into an actionable E_INTERNAL', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const err = (await new HuskClient({ fetch }).health().catch((e: unknown) => e)) as HuskError;
    expect(err.message).toContain('cannot reach the husk control plane');
    expect(err.hint).toContain('husk serve');
  });

  it('reports an aborted request as E_ABORTED, not a connection failure', async () => {
    const fetch: FetchLike = async () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    };
    const err = (await new HuskClient({ fetch }).health().catch((e: unknown) => e)) as HuskError;
    expect(err.code).toBe('E_ABORTED');
  });

  it('carries a mid-stream error frame out as the server-sent code', async () => {
    const { fetch } = stub(() =>
      sse('event: error\ndata: {"error":{"code":"E_EXEC_DENIED","message":"nope","hint":"allowlist it"}}\n\n'),
    );
    const it = new HuskClient({ fetch }).computers.execStream('c1', { cmd: 'sudo rm -rf /' });
    const err = await (async () => {
      try {
        for await (const _ of it) void _;
      } catch (e) {
        return e as HuskError;
      }
      throw new Error('expected the stream to throw');
    })();
    expect(err.code).toBe('E_EXEC_DENIED');
    expect(err.hint).toBe('allowlist it');
  });
});

describe('responses', () => {
  it('returns undefined for 204 rather than choking on an empty body', async () => {
    const { fetch } = stub(() => new Response(null, { status: 204 }));
    await expect(new HuskClient({ fetch }).computers.destroy('c1')).resolves.toBeUndefined();
  });

  it('streams exec events in order and swallows the terminating done frame', async () => {
    const { fetch } = stub(() =>
      sse(
        ': husk stream open\n\n' +
          'data: {"type":"stdout","data":"hi\\n"}\n\n' +
          ': ping\n\n' +
          'data: {"type":"exit","result":{"exitCode":0,"stdout":"hi\\n","stderr":"","durationMs":5,"truncated":false,"timedOut":false}}\n\n' +
          'event: done\ndata: {}\n\n',
      ),
    );
    const seen: unknown[] = [];
    for await (const ev of new HuskClient({ fetch }).computers.execStream('c1', { cmd: 'echo hi' })) {
      seen.push(ev);
    }
    expect(seen.map((e) => (e as { type: string }).type)).toEqual(['stdout', 'exit']);
  });
});

describe('timeouts', () => {
  it('gives exec a client timeout derived from the requested exec timeout', async () => {
    const { fetch } = stub(() => json({ exitCode: 0 }));
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await new HuskClient({ fetch }).computers.exec('c1', { cmd: 'sleep 60', timeoutSec: 60 });
    // 60s exec + 15s of slack, so the server's timeout error wins the race.
    expect(spy.mock.calls.some(([, ms]) => ms === 75_000)).toBe(true);
    spy.mockRestore();
  });

  it('never times out a run on the client side', async () => {
    const { fetch } = stub(() => json({ runId: 'r1' }));
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const before = spy.mock.calls.length;
    await new HuskClient({ fetch }).husks.run('bot', { input: 'hi' });
    expect(spy.mock.calls.length).toBe(before);
    spy.mockRestore();
  });
});

describe('websockets', () => {
  it('says what to do when the runtime has no WebSocket', () => {
    const { fetch } = stub(() => json({}));
    const client = new HuskClient({ fetch, webSocket: undefined as never });
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      const bare = new HuskClient({ fetch });
      const err = (() => {
        try {
          bare.events();
        } catch (e) {
          return e as HuskError;
        }
        throw new Error('expected events() to throw');
      })();
      expect(err.code).toBe('E_NOT_IMPLEMENTED');
      expect(err.hint).toContain("import('ws')");
    } finally {
      if (original) (globalThis as { WebSocket?: unknown }).WebSocket = original;
    }
    expect(client.baseUrl).toBe('http://127.0.0.1:7377');
  });
});
