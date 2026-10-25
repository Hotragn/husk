/**
 * A chat's tools and handoffs when the shared Husk is running: tools run
 * there, the person takes over in its console, and the chat keeps a local
 * mirror so its own checks still hold.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Computer, Logger } from '@husk-ai/core';
import type { ComputerManager } from '@husk-ai/runtime';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonUnreachable, RunLocally } from './daemon.js';
import type { DaemonClient } from './daemon.js';
import { HuskMcpServer } from './server.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const info = {
  id: 'cmp_chat', name: 'chat', provider: 'docker', state: 'running', image: 'x', workdir: '/work',
  createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), spec: { provider: 'docker', labels: { 'husk.chat': 'Claude Code · chat' } },
};
const computer = { id: 'cmp_chat', info, async refresh() { return info; }, async exec() { throw new Error('ran locally'); } } as unknown as Computer;

function fakeShared() {
  const open = new Set<string>();
  const ended = new Map<string, 'done' | 'aborted'>();
  const log: string[] = [];
  const shared: DaemonClient = {
    url: 'http://127.0.0.1:7377',
    async callTool(id, name) {
      log.push(`tool ${id} ${name}`);
      return { content: [{ type: 'text', text: `ran ${name} in the shared husk` }] };
    },
    async openHandoff(id, reason, label) {
      log.push(`open ${id} ${reason} ${label}`);
      open.add('hnd_remote');
      return { handoffId: 'hnd_remote', token: 'linktoken' };
    },
    async state(h) { return open.has(h) ? 'open' : (ended.get(h) ?? 'unknown'); },
    async complete(h) { log.push(`done ${h}`); open.delete(h); ended.set(h, 'done'); },
    async cancel(h) { log.push(`cancel ${h}`); open.delete(h); ended.set(h, 'aborted'); },
    async linkToken() { return 'cardtoken'; },
    async markInChat(id) { log.push(`in-chat ${id}`); },
    async stop(id) { log.push(`stop ${id}`); },
  };
  return { shared, open, ended, log };
}

const servers: HuskMcpServer[] = [];
beforeEach(() => vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'test-session'));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function chat(shared: DaemonClient, connect?: () => Promise<DaemonClient | undefined>) {
  const manager = { async ensure() { return computer; }, async create() { return computer; } } as unknown as ComputerManager;
  const server = new HuskMcpServer({
    manager, ephemeral: false, logger: silent, shared, ...(connect ? { connect } : {}),
    workspaceStore: new WorkspaceStore({ root: mkdtempSync(join(tmpdir(), 'husk-shared-')) }),
  });
  servers.push(server);
  const client = new Client({ name: 'some-client', version: '0' }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(s), client.connect(c)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown };
    return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n'), structured: r.structuredContent };
  };
}

describe('with the shared Husk', { timeout: 30_000 }, () => {
  it('runs computer tools there, not in the chat process', async () => {
    const f = fakeShared();
    const call = await chat(f.shared);
    const r = await call('shell', { command: 'ls' });
    expect(r.text).toContain('ran shell in the shared husk');
    expect(f.log).toContain('tool cmp_chat shell');
  });

  it('hands off in the shared console, holds the computer, and frees it when the chat relays done', async () => {
    const f = fakeShared();
    const call = await chat(f.shared);
    await call('shell', { command: 'ls' });
    const handed = await call('hand_off', { reason: 'Sign in to GitHub' });
    expect(f.log).toContain('open cmp_chat Sign in to GitHub Claude Code · chat');
    expect(handed.text).toContain('http://127.0.0.1:7377/#handoff=hnd_remote&token=linktoken');

    const held = await call('shell', { command: 'ls' });
    expect(held.isError).toBe(true);
    const localId = /handoff (hnd_[a-z0-9]+)/i.exec(held.text)?.[1];
    expect(localId).toBeTruthy();

    await call('hand_off_done', { handoff: localId });
    expect(f.log).toContain('done hnd_remote');
    expect((await call('shell', { command: 'ls' })).isError).toBe(false);
  });

  it('shows on its card that the person took the computer in the console', async () => {
    const f = fakeShared();
    f.shared.holdOn = async () => ({ handoffId: 'hnd_console', runId: 'person', reason: 'You took over this computer' });
    const call = await chat(f.shared);
    await call('shell', { command: 'ls' });
    const card = await call('computer_card_state', { computer: 'cmp_chat' });
    expect(card.structured).toMatchObject({ computerId: 'cmp_chat', held: { handoffId: 'hnd_console' } });
    expect(card.structured).not.toHaveProperty('waiting');
  });

  it('frees the chat when the person presses done in the console', async () => {
    const f = fakeShared();
    const call = await chat(f.shared);
    await call('shell', { command: 'ls' });
    await call('hand_off', { reason: 'Approve the payment' });
    f.open.delete('hnd_remote'); // the console's Done
    f.ended.set('hnd_remote', 'done');
    await new Promise((r) => setTimeout(r, 2_500));
    expect((await call('shell', { command: 'ls' })).isError).toBe(false);
  });

  it('cancels its handoff in the shared Husk when the chat goes away', async () => {
    const f = fakeShared();
    const call = await chat(f.shared);
    await call('shell', { command: 'ls' });
    await call('hand_off', { reason: 'Sign in' });
    await servers.pop()!.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.log).toContain('cancel hnd_remote');
  });

  it('does not tell the model "handed back" when the shared Husk cancelled the handoff', async () => {
    const f = fakeShared();
    const call = await chat(f.shared);
    await call('shell', { command: 'ls' });
    const handed = await call('hand_off', { reason: 'Sign in' });
    const localId = /handoff "(hnd_[a-z0-9]+)"/i.exec(handed.text)?.[1] ?? '';
    f.open.delete('hnd_remote');
    f.ended.set('hnd_remote', 'aborted'); // expired, or lost in a restart
    await new Promise((r) => setTimeout(r, 2_500));
    const done = await call('hand_off_done', { handoff: localId });
    expect(done.isError).toBe(true);
  });

  it("runs a computer's tools here when the shared Husk cannot see it", async () => {
    const f = fakeShared();
    f.shared.callTool = async () => {
      throw new RunLocally('cannot see it');
    };
    const call = await chat(f.shared);
    const r = await call('shell', { command: 'ls' });
    // The fake computer's own exec throws "ran locally": the call came here.
    expect(r.text).toContain('ran locally');
  });

  it("links a computer whose tools run here to this process's viewer, never to the shared Husk", async () => {
    const f = fakeShared();
    f.shared.callTool = async () => {
      throw new RunLocally('cannot see it');
    };
    const asked: string[] = [];
    f.shared.linkToken = async (id) => {
      asked.push(id);
      throw new RunLocally('no such computer there');
    };
    const call = await chat(f.shared);
    const first = await call('shell', { command: 'ls' });
    expect(first.text).toMatch(/take it over at http:\/\/127\.0\.0\.1:\d+\/#computer=cmp_chat&token=[0-9a-f]{64} /);
    expect(first.text).not.toContain('undefined');
    expect(first.text).not.toContain(':7377');
    expect(asked).toEqual([]);
  });

  it('falls back to its own viewer when the shared Husk has no link for the computer', async () => {
    const f = fakeShared();
    f.shared.linkToken = async () => {
      throw new RunLocally('no such computer there');
    };
    const call = await chat(f.shared);
    const first = await call('shell', { command: 'ls' });
    expect(first.text).toMatch(/take it over at http:\/\/127\.0\.0\.1:\d+\/#computer=cmp_chat&token=[0-9a-f]{64} /);
    expect(first.text).not.toContain(':7377');
  });

  it("accepts the shared Husk's own handoff id in hand_off_done", async () => {
    const f = fakeShared();
    const call = await chat(f.shared);
    await call('shell', { command: 'ls' });
    await call('hand_off', { reason: 'Sign in' });
    expect((await call('hand_off_done', { handoff: 'hnd_remote' })).isError).toBe(false);
    expect(f.log).toContain('done hnd_remote');
  });
});

describe('when the shared Husk goes away mid-chat', { timeout: 30_000 }, () => {
  const gone = (): DaemonClient => ({
    ...fakeShared().shared,
    async callTool() {
      throw new DaemonUnreachable('the shared husk at http://127.0.0.1:7377 refused the connection');
    },
  });

  it('starts it again and retries the call there, once', async () => {
    const again = fakeShared();
    const call = await chat(gone(), async () => again.shared);
    const r = await call('shell', { command: 'ls' });
    expect(r.text).toContain('ran shell in the shared husk');
    expect(r.text).not.toContain("chat's own process");
  });

  it('runs the call here only when it cannot be started again, and says so once', async () => {
    const call = await chat(gone(), async () => undefined);
    const first = await call('shell', { command: 'ls' });
    expect(first.text).toContain("running in this chat's own process (the shared husk at http://127.0.0.1:7377 refused the connection)");
    expect(first.text).toContain('ran locally');
    expect((await call('shell', { command: 'ls' })).text).not.toContain("chat's own process");
  });
});

describe('a computer the shared Husk cannot reach', { timeout: 30_000 }, () => {
  it('runs here, is marked in the console, and the chat is told once', async () => {
    const f = fakeShared();
    f.shared.callTool = async (id) => {
      throw new RunLocally(`the shared husk cannot see computer ${id}`);
    };
    const call = await chat(f.shared);
    const first = await call('shell', { command: 'ls' });
    expect(first.text).toContain("running in this chat's own process (the shared husk cannot see computer cmp_chat)");
    expect(f.log).toContain('in-chat cmp_chat');
    expect((await call('shell', { command: 'ls' })).text).not.toContain("chat's own process");
  });
});
