/**
 * An app on MCP 2026-07-28 (J6-b): it opens with server/discover, says who it
 * is on every request, and answers "Done?" by calling again. The same server
 * still serves an app that opens with `initialize`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ElicitResult } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { Computer, ComputerSpec, Logger } from '@husk-ai/core';
import type { ComputerManager } from '@husk-ai/runtime';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HuskMcpServer } from './server.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

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
  async exec() {
    return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, truncated: false, timedOut: false };
  },
  async destroy() {},
  async refresh() {
    return computer.info;
  },
} as unknown as Computer;

const open: HuskMcpServer[] = [];
const served: StdioServerHandle[] = [];
// One chat per process, as Claude Code runs it.
beforeEach(() => vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'test-session'));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(served.splice(0).map((h) => h.close()));
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** A chat through the same entry the stdio bin uses, on 2026-07-28 unless `legacy`. */
async function chat(opts: { answer?: () => ElicitResult; legacy?: boolean } = {}) {
  const specs: ComputerSpec[] = [];
  const manager = {
    async ensure(_key: string, spec: ComputerSpec) {
      specs.push(spec);
      return computer;
    },
    async create() {
      return computer;
    },
  } as unknown as ComputerManager;
  const workspaceStore = new WorkspaceStore({ root: mkdtempSync(join(tmpdir(), 'husk-modern-')) });
  const server = new HuskMcpServer({ manager, ephemeral: false, daemon: false, logger: silent, workspaceStore });
  open.push(server);
  const [c, s] = InMemoryTransport.createLinkedPair();
  served.push(serveStdio(() => server.server, { transport: s }));
  const client = new Client(
    { name: 'claude-code', version: '0' },
    { capabilities: opts.answer ? { elicitation: {} } : {}, ...(opts.legacy ? {} : { versionNegotiation: { mode: { pin: '2026-07-28' } } }) },
  );
  const asked: string[] = [];
  if (opts.answer) {
    const answer = opts.answer;
    client.setRequestHandler('elicitation/create', async (req) => {
      asked.push(String((req.params as { message?: string }).message));
      return answer();
    });
  }
  await client.connect(c);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
    return { isError: r.isError === true, text: r.content.map((x) => x.text ?? '').join('\n') };
  };
  return { client, call, asked, specs };
}

describe('an app on MCP 2026-07-28', () => {
  it('is served on 2026-07-28, and Husk knows the app from its requests alone', async () => {
    const { client, call, specs } = await chat();
    expect(client.getProtocolEra()).toBe('modern');
    const tools = (await client.listTools()).tools.map((t) => t.name);
    // Claude Code gives up on a quiet call, so it gets job_wait: Husk read its name from a request.
    expect(tools).toEqual(expect.arrayContaining(['shell', 'hand_off', 'job_wait']));
    expect((await call('shell', { command: 'echo hi' })).text).toContain('ok');
    expect(specs[0]?.labels?.['husk.platform']).toBe('Claude Code');
  });

  it('asks "Done?" by input_required, and the answer hands the computer back', async () => {
    const { call, asked } = await chat({ answer: () => ({ action: 'accept', content: { done: true } }) });
    await call('shell', { command: 'echo hi' });
    const r = await call('hand_off', { reason: 'Sign in to your bank.' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('#handoff=');
    expect(r.text).toContain('the computer is yours again');
    expect((await call('shell', { command: 'echo back' })).isError).toBe(false);
  });

  it('leaves the handoff open on "not yet", with the link to relay', async () => {
    const { call, asked } = await chat({ answer: () => ({ action: 'decline' }) });
    await call('shell', { command: 'echo hi' });
    const r = await call('hand_off', { reason: 'Sign in to your bank.' });
    expect(asked).toHaveLength(1);
    const handoff = /^Handoff (\S+) is open/.exec(r.text)?.[1];
    expect(handoff).toBeDefined();
    expect(r.text).toContain('#handoff=');
    expect((await call('shell', { command: 'echo blocked' })).isError).toBe(true);
    expect((await call('hand_off_done', { handoff })).text).toContain('the computer is yours again');
  });

  it('still serves an app that opens with initialize, and asks it the older way', async () => {
    const { client, call, asked } = await chat({ legacy: true, answer: () => ({ action: 'accept', content: { done: true } }) });
    expect(client.getProtocolEra()).toBe('legacy');
    await call('shell', { command: 'echo hi' });
    expect((await call('hand_off', { reason: 'Sign in to your bank.' })).text).toContain('the computer is yours again');
    expect(asked).toHaveLength(1);
  });
});
