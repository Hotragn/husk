/**
 * The correction actually reaching a client.
 *
 * `toolsFor` can be asserted directly, and `degraded-tools.test.ts` does. What
 * that cannot show is the part the design rests on: that the notification is
 * sent at the right moment, that a client acts on it, and that re-listing then
 * yields the corrected text. Those are protocol behaviours, so this drives a
 * real `Client` over a real transport rather than reading the server's fields.
 *
 * No computer is created. The manager is replaced with one that hands back a
 * plain object, because the only thing the server reads from a computer here
 * is one label -- and booting a container to assert a string would make this a
 * test of Docker.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Computer, Logger } from '@husk-ai/core';
import type { ComputerManager } from '@husk-ai/runtime';
import { describe, expect, it } from 'vitest';
import { HuskMcpServer } from './server.js';

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function fakeComputer(labels: Record<string, string>): Computer {
  return {
    id: 'cmp_fake',
    info: {
      id: 'cmp_fake',
      name: 'fake',
      provider: 'local',
      state: 'running',
      image: 'x',
      workdir: '/work',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      spec: { provider: 'local', labels },
    },
    async exec() {
      return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, truncated: false, timedOut: false };
    },
    async destroy() {},
  } as unknown as Computer;
}

/** Connect a client, call one tool, and report what the tool list did. */
async function session(labels: Record<string, string>) {
  const manager = { async ensure() { return fakeComputer(labels); }, async create() { return fakeComputer(labels); } } as unknown as ComputerManager;
  const server = new HuskMcpServer({ manager, ephemeral: false, logger: silent });
  const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();

  let notified = 0;
  client.setNotificationHandler('notifications/tools/list_changed', () => {
    notified++;
  });

  await Promise.all([server.server.connect(serverT), client.connect(clientT)]);

  const shell = async () => {
    const t = (await client.listTools()).tools.find((x) => x.name === 'shell');
    if (!t) throw new Error('no shell tool');
    const props = t.inputSchema.properties as Record<string, { description?: string }>;
    return { description: t.description ?? '', command: props.command?.description ?? '' };
  };

  const before = await shell();
  await client.callTool({ name: 'shell', arguments: { command: 'echo hi' } });
  const after = await shell();
  const instructions = client.getInstructions() ?? '';

  await client.close();
  await server.close();
  return { notified, before, after, instructions };
}

describe('a client whose computer turns out not to be Linux', () => {
  it('is told the tool list changed, once', async () => {
    const s = await session({ 'husk.shell': 'windows', 'husk.degradation': 'wsl-broken' });
    expect(s.notified).toBe(1);
  });

  it('gets a shell description that no longer promises Linux or sh -c', async () => {
    const s = await session({ 'husk.shell': 'windows', 'husk.degradation': 'wsl-absent' });
    expect(s.before.description).toMatch(/your Linux computer/);
    expect(s.after.description).not.toMatch(/Linux computer/);
    expect(s.after.command).toMatch(/cmd\.exe/);
    expect(s.after.command).not.toMatch(/sh -c/);
  });
});

describe('a client whose computer is fine', () => {
  it('is not notified, and sees no change', async () => {
    // The cost of this design falls entirely on the degraded path. A healthy
    // session must not re-fetch its tool list for nothing.
    const s = await session({ 'husk.shell': 'wsl:Ubuntu' });
    expect(s.notified).toBe(0);
    expect(s.after).toEqual(s.before);
  });
});

describe('the instructions sent at initialize', () => {
  it('do not promise Linux, because they can never be corrected', async () => {
    // Unlike the tool list, these are sent once during initialize. There is no
    // notification that replaces them, so the only way for them to be true on
    // every host is to not overclaim on any.
    const s = await session({ 'husk.shell': 'wsl:Ubuntu' });
    expect(s.instructions).not.toMatch(/gives you a Linux computer/);
    expect(s.instructions).toMatch(/cmd\.exe/);
  });
});
