/**
 * Remote access's /mcp (J6-c), as the shared Husk serves it to a signed-in
 * app: MCP over Streamable HTTP, on both protocol eras, with each app's
 * computers bound under the owner and apart from this machine's chats.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Computer, ComputerSpec, Logger } from '@husk-ai/core';
import type { ComputerManager } from '@husk-ai/runtime';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { describe, expect, it } from 'vitest';
import { createRemoteMcp } from './remote.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function fakeManager() {
  const bindings = new Map<string, string>();
  const made: Array<{ id: string; spec: ComputerSpec }> = [];
  const computerOf = (id: string, spec: ComputerSpec) => {
    const info = { id, name: id, provider: spec.provider ?? 'docker', state: 'running', image: 'x', workdir: '/work', createdAt: '', lastUsedAt: '', spec };
    return {
      id,
      info,
      async exec() {
        return { exitCode: 0, stdout: `on ${id}`, stderr: '', durationMs: 1, truncated: false, timedOut: false };
      },
      async refresh() {
        return info;
      },
      async destroy() {},
    } as unknown as Computer;
  };
  const manager = {
    async ensure(key: string, spec: ComputerSpec) {
      const id = `cmp_${made.length + 1}`;
      made.push({ id, spec });
      bindings.set(key, id);
      return computerOf(id, spec);
    },
    async keyFor(id: string) {
      for (const [k, v] of bindings) if (v === id) return k;
      return undefined;
    },
    async get(id: string) {
      const m = made.find((x) => x.id === id);
      return m ? computerOf(id, m.spec) : null;
    },
  } as unknown as ComputerManager;
  return { manager, bindings, made };
}

/** A chat app signed in as `client`, talking to /mcp, on 2026-07-28 unless `legacy`. */
async function app(remote: ReturnType<typeof createRemoteMcp>, client: string, legacy = false) {
  const transport = new StreamableHTTPClientTransport(new URL('https://box.tail1234.ts.net/mcp'), {
    fetch: (url, init) => remote(new Request(url, init), { owner: 'owner-1', client, name: client === 'c1' ? 'Claude' : 'ChatGPT' }),
  });
  const c = new Client({ name: 'web-app', version: '0' }, legacy ? {} : { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await c.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
    return { isError: r.isError === true, text: r.content.map((x) => x.text ?? '').join('\n') };
  };
  return { client: c, call };
}

describe('/mcp for a signed-in app', () => {
  const setup = () => {
    const fake = fakeManager();
    const workspaceStore = new WorkspaceStore({ root: mkdtempSync(join(tmpdir(), 'husk-remote-mcp-')) });
    const remote = createRemoteMcp({ provider: 'docker', logger: silent, husk: { manager: fake.manager, daemon: false, logger: silent, workspaceStore } });
    return { ...fake, remote };
  };

  it('serves an app on 2026-07-28, and one on the older protocol, one request at a time', async () => {
    const { remote } = setup();
    const modern = await app(remote, 'c1');
    expect(modern.client.getProtocolEra()).toBe('modern');
    const tools = (await modern.client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['shell', 'hand_off']));
    const legacy = await app(remote, 'c1', true);
    expect(legacy.client.getProtocolEra()).toBe('legacy');
    expect((await legacy.client.listTools()).tools.length).toBe(tools.length);
  });

  it('gives each chat its own computer by id, bound under the owner, on the isolated provider', async () => {
    const { remote, bindings, made } = setup();
    const { call } = await app(remote, 'c1');
    const first = await call('shell', { computer: 'new', command: 'echo hi' });
    const id = /computer: "(cmp_\w+)"/.exec(first.text)?.[1];
    expect(id).toBe('cmp_1');
    expect([...bindings.keys()][0]).toMatch(/^remote:owner-1:/);
    expect(made[0]?.spec).toMatchObject({ provider: 'docker', labels: { 'husk.platform': 'Claude' } });
    expect((await call('shell', { computer: id, command: 'echo again' })).text).toContain('on cmp_1');
  });

  it('offers no workspace tools, which work on this machine’s own files and network', async () => {
    const { remote } = setup();
    const { client, call } = await app(remote, 'c1');
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.some((t) => t.startsWith('workspace_') || t === 'source_add')).toBe(false);
    const r = await call('source_add', { url: 'http://192.168.1.1/' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not offered remotely');
  });

  it('never reaches a computer this machine’s chats made', async () => {
    const { remote, bindings, manager } = setup();
    // A chat on this machine (stdio) made one.
    await manager.ensure('chat:local-1', { provider: 'local' });
    expect(bindings.get('chat:local-1')).toBe('cmp_1');
    const { call } = await app(remote, 'c1');
    const r = await call('shell', { computer: 'cmp_1', command: 'cat ~/.ssh/id_ed25519' });
    expect(r.text).toContain('There is no Husk computer "cmp_1"');
  });
});
