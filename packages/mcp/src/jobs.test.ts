/**
 * A call that outlasts its chat app's wait answers "still running" before the
 * app gives up on it, goes on, and is collected with job_wait (J6-a).
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
import { HuskMcpServer } from './server.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

let ran = 0;
const computer = {
  id: 'cmp_fake',
  info: {
    id: 'cmp_fake',
    name: 'fake',
    provider: 'docker',
    state: 'running',
    image: 'x',
    workdir: '/work',
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    spec: { provider: 'docker' },
  },
  // `sleep N; echo text`, as long as it says, at a millisecond a "second".
  async exec({ cmd }: { cmd: string }) {
    ran++;
    const [, ms, text] = /sleep (\d+); echo (.*)/.exec(cmd) ?? [, '0', cmd];
    await new Promise((r) => setTimeout(r, Number(ms)));
    return { exitCode: 0, stdout: `${text}\n`, stderr: '', durationMs: Number(ms), truncated: false, timedOut: false };
  },
  async destroy() {},
  async refresh() {
    return computer.info;
  },
} as unknown as Computer;

const open: HuskMcpServer[] = [];
beforeEach(() => {
  ran = 0;
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'test-session');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function chat(clientName: string, callWaitMs?: number) {
  const manager = { async ensure() { return computer; }, async create() { return computer; } } as unknown as ComputerManager;
  const workspaceStore = new WorkspaceStore({ root: mkdtempSync(join(tmpdir(), 'husk-jobs-')) });
  const server = new HuskMcpServer({ manager, ephemeral: false, daemon: false, logger: silent, workspaceStore, ...(callWaitMs ? { callWaitMs } : {}) });
  open.push(server);
  const client = new Client({ name: clientName, version: '0' }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(s), client.connect(c)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') };
  };
  const tools = async () => (await client.listTools()).tools.map((t) => t.name);
  return { call, tools };
}

describe('a call that outlasts its app’s wait', () => {
  it('answers "still running" in time, goes on, and job_wait collects it once', async () => {
    const { call } = await chat('Zed', 100);
    const first = await call('shell', { command: 'sleep 400; echo built' });
    expect(first.isError).toBe(false);
    const job = /job_wait with job "([\w-]+)"/.exec(first.text)?.[1];
    expect(first.text).toMatch(/^shell is still running after \d+s/);
    expect(job).toBeDefined();

    // Not done after one more wait: said again, with the same job.
    let done = await call('job_wait', { job });
    expect(done.text).toContain(`job_wait with job "${job}"`);
    for (let i = 0; i < 10 && /still running/.test(done.text); i++) done = await call('job_wait', { job });
    expect(done.text).toContain('built');
    expect(ran).toBe(1);

    const twice = await call('job_wait', { job });
    expect(twice.isError).toBe(true);
    expect(twice.text).toContain('no job');
  });

  it('answers a call that ends within the wait as before', async () => {
    const { call } = await chat('Zed', 200);
    expect((await call('shell', { command: 'sleep 10; echo quick' })).text).toContain('quick');
  });

  it('shows job_wait only to apps that give up on a call', async () => {
    expect(await (await chat('Zed')).tools()).toContain('job_wait');
    expect(await (await chat('codex-mcp-client')).tools()).toContain('job_wait');
    expect(await (await chat('Visual Studio Code')).tools()).not.toContain('job_wait');
  });
});
