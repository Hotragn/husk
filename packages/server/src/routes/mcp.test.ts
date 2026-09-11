import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '@husk/core';
import type { Computer, ComputerInfo, ComputerSpec } from '@husk/core';
import { createApp } from '../app.js';
import type { ManagerLike } from '../deps.js';
import { assertMcpBindIsSafe, assertProviderMayServeRemote, sessionBindingKey } from '../mcp-session.js';
import { FakeComputer, FakeManager, fakeModelProvider, tempStore } from '../testing.js';

/**
 * The remote MCP endpoint.
 *
 * Three things here are not "does the transport work" -- the SDK's job -- but
 * "does husk refuse the things it must refuse": an unisolated provider behind a
 * remote endpoint, a public bind with no credential, and two sessions landing
 * on one filesystem. Each of those is a security property, and each was a live
 * defect before this endpoint existed.
 */

/** A manager whose provider claims real isolation, unlike `FakeManager`. */
class IsolatedManager extends FakeManager {
  readonly ensured: string[] = [];
  private readonly byKey = new Map<string, FakeComputer>();

  override async status(): Promise<
    Array<{ name: string; description: string; priority: number; available: boolean; isolated?: boolean }>
  > {
    return [{ name: 'docker', description: 'containers', priority: 20, available: true, isolated: true }];
  }

  async ensure(key: string, spec: ComputerSpec = {}): Promise<Computer> {
    this.ensured.push(key);
    let c = this.byKey.get(key);
    if (!c) {
      c = (await this.create(spec)) as FakeComputer;
      this.byKey.set(key, c);
    }
    return c;
  }

  async release(): Promise<boolean> {
    return false;
  }
}

const harnesses: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of harnesses.splice(0)) await close();
});

async function build(opts: { manager?: ManagerLike; token?: string; host?: string } = {}) {
  const { store, root, cleanup } = await tempStore();
  const app = await createApp({
    manager: opts.manager ?? new IsolatedManager(),
    router: { chat: async () => ({}) as never, stream: async function* () {} },
    store,
    modelProviders: [fakeModelProvider],
    logger: createLogger({ level: 'silent' }),
    config: {
      host: opts.host ?? '127.0.0.1',
      port: 0,
      token: opts.token,
      triggers: false,
      consoleDir: `${root}/no-console`,
    },
  });
  harnesses.push(async () => {
    await app.close();
    await store.close();
    await cleanup();
  });
  return app;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

describe('the endpoint is mounted and describes itself', () => {
  it('advertises streamable http at /mcp', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/mcp/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ transport: 'streamable-http', path: '/mcp', authRequired: false });
  });

  it('says whether a token is required, so a client knows which failure it hit', async () => {
    const app = await build({ token: 'secret' });
    const res = await app.inject({
      method: 'GET',
      url: '/mcp/info',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.json()).toMatchObject({ authRequired: true });
  });

  it('is behind the control plane auth hook, not a second scheme', async () => {
    const app = await build({ token: 'secret' });
    expect((await app.inject({ method: 'GET', url: '/mcp/info' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/mcp', payload: INITIALIZE })).statusCode).toBe(401);
  });
});

describe('initialize', () => {
  it('completes a handshake and mints a session id', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: INITIALIZE,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['mcp-session-id']).toBeTruthy();
    // The body is an SSE frame carrying the JSON-RPC result.
    expect(res.body).toContain('"protocolVersion"');
    expect(res.body).toContain('"serverInfo"');
  });

  it('advertises resources as well as tools, so a client can render a file', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: INITIALIZE,
    });
    expect(res.body).toContain('"resources"');
    expect(res.body).toContain('"tools"');
  });

  it('refuses a request for a session it has never seen', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'nope' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.hint).toMatch(/re-initialize/);
  });
});

describe('tools reach the real tool surface', () => {
  async function initialised() {
    const app = await build();
    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: INITIALIZE,
    });
    const sessionId = init.headers['mcp-session-id'] as string;
    await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    return { app, sessionId };
  }

  it('lists the same tools the stdio server mounts', async () => {
    const { app, sessionId } = await initialised();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    });

    expect(res.statusCode).toBe(200);
    // Mounted unchanged: the transport is the only thing that is new.
    for (const name of ['shell', 'read_file', 'write_file', 'browse', 'computer_info', 'expose_port']) {
      expect(res.body).toContain(`"${name}"`);
    }
  });

  it('runs a tool call against a computer bound to the session', async () => {
    const { app, sessionId } = await initialised();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      payload: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'shell', arguments: { command: 'echo hello' } },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ran: echo hello');
  });
});

describe('two sessions do not share one /work', () => {
  it('binds a different key per session id', async () => {
    const manager = new IsolatedManager();
    const app = await build({ manager });

    const keysFor = async () => {
      const init = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        payload: INITIALIZE,
      });
      const sessionId = init.headers['mcp-session-id'] as string;
      await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
        },
        payload: {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'shell', arguments: { command: 'pwd' } },
        },
      });
    };

    await keysFor();
    await keysFor();

    // Two chats, two binding keys, two computers. Sharing one would mean each
    // could read the other's files.
    expect(new Set(manager.ensured).size).toBe(2);
  });
});

describe('sessionBindingKey', () => {
  it('separates two credentials even when they claim the same session', () => {
    const a = sessionBindingKey({ token: 'alice', explicitSession: 'shared' });
    const b = sessionBindingKey({ token: 'bob', explicitSession: 'shared' });
    expect(a.key).not.toBe(b.key);
  });

  it('separates two sessions under one credential', () => {
    const a = sessionBindingKey({ token: 't', mcpSessionId: 'one' });
    const b = sessionBindingKey({ token: 't', mcpSessionId: 'two' });
    expect(a.key).not.toBe(b.key);
  });

  it('is stable for the same credential and session, so /work comes back', () => {
    expect(sessionBindingKey({ token: 't', explicitSession: 'proj' }).key).toBe(
      sessionBindingKey({ token: 't', explicitSession: 'proj' }).key,
    );
  });

  it('never writes the credential into the key, which reaches disk and a label', () => {
    const secret = 'hunter2-super-secret-token';
    expect(sessionBindingKey({ token: secret, explicitSession: 'x' }).key).not.toContain(secret);
  });

  it('prefers an explicit session over a negotiated one, so a client can pin a workspace', () => {
    const k = sessionBindingKey({ token: 't', explicitSession: 'pinned', mcpSessionId: 'ephemeral' });
    expect(k.source).toBe('explicit');
    expect(k.key).toContain('s-pinned');
  });

  it('falls back to one workspace per credential when the protocol has no sessions', () => {
    // The 2026-07-28 revision removed protocol-level sessions. Degrading to a
    // shared workspace here would have been a silent loss of isolation.
    const k = sessionBindingKey({ token: 't' });
    expect(k.source).toBe('principal');
    expect(k.key.endsWith(':default')).toBe(true);
  });

  it('hashes a session id that could otherwise choose bytes in a path', () => {
    const k = sessionBindingKey({ token: 't', explicitSession: '../../etc/passwd' });
    expect(k.key).not.toContain('..');
    expect(k.key).not.toContain('/');
  });
});

describe('an unisolated provider cannot back a remote endpoint', () => {
  it('refuses `local`, whatever the binding says', async () => {
    // FakeManager reports the real local provider's shape: available, not isolated.
    await expect(assertProviderMayServeRemote(new FakeManager())).rejects.toMatchObject({
      code: 'E_EXEC_DENIED',
    });
  });

  it('explains why, rather than just saying no', async () => {
    await expect(assertProviderMayServeRemote(new FakeManager())).rejects.toThrowError(
      /not isolated, so it cannot back the remote MCP endpoint/,
    );
  });

  it('refuses it when named explicitly too, not only via auto-selection', async () => {
    await expect(
      assertProviderMayServeRemote(new FakeManager(), { provider: 'local' }),
    ).rejects.toMatchObject({ code: 'E_EXEC_DENIED' });
  });

  it('allows a provider that claims isolation', async () => {
    await expect(assertProviderMayServeRemote(new IsolatedManager())).resolves.toBeUndefined();
  });

  it('surfaces the refusal through the endpoint instead of running a shell', async () => {
    const app = await build({ manager: new FakeManager() });
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: INITIALIZE,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.hint).toMatch(/Docker|fly/);
  });
});

describe('assertMcpBindIsSafe', () => {
  it('allows loopback with no token', () => {
    expect(() => assertMcpBindIsSafe('127.0.0.1', undefined)).not.toThrow();
    expect(() => assertMcpBindIsSafe('localhost', undefined)).not.toThrow();
  });

  it('allows any host once a token is configured', () => {
    expect(() => assertMcpBindIsSafe('0.0.0.0', 'secret')).not.toThrow();
  });

  it('refuses a public bind with no token', () => {
    expect(() => assertMcpBindIsSafe('0.0.0.0', undefined)).toThrowError(/without an auth token/);
    expect(() => assertMcpBindIsSafe('192.168.1.5', undefined)).toThrowError(/without an auth token/);
  });

  it('stops the server coming up at all, rather than serving an open endpoint', async () => {
    await expect(build({ host: '0.0.0.0' })).rejects.toThrowError(/without an auth token/);
  });
});

describe('resources', () => {
  it('lists files the bot wrote to /work', async () => {
    const manager = new IsolatedManager();
    const app = await build({ manager });
    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: INITIALIZE,
    });
    const sessionId = init.headers['mcp-session-id'] as string;

    const call = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
        },
        payload: payload as never,
      });

    await call({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'write_file', arguments: { path: '/work/report.md', content: '# done' } },
    });

    const listed = await call({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    expect(listed.body).toContain('husk://work/report.md');

    const read = await call({
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/read',
      params: { uri: 'husk://work/report.md' },
    });
    expect(read.body).toContain('# done');
  });
});

/** Keeps `ComputerInfo` imported for the manager subclass above. */
export type _Info = ComputerInfo;
