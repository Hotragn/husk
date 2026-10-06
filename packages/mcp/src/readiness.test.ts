import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLogger } from '@husk-ai/core';
import type { Computer, ComputerInfo } from '@husk-ai/core';
import type { ComputerManager } from '@husk-ai/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HuskMcpServer } from './server.js';
import type { HuskMcpOptions } from './server.js';

const close: Array<() => Promise<void>> = [];
beforeEach(() => vi.stubEnv('HUSK_SESSION', undefined));
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
  vi.unstubAllEnvs();
});

async function session(options: Pick<HuskMcpOptions, 'sessionKey' | 'ephemeral'> = {}) {
  const info = { id: 'cmp_test', state: 'running', provider: 'docker', spec: {} } as ComputerInfo;
  const activity = { starts: 0, executions: 0, creations: [] as unknown[], bindings: [] as string[] };
  const start = vi.fn(async () => { activity.starts++; info.state = 'running'; });
  const refresh = vi.fn(async () => info);
  const exec = async () => { activity.executions++; return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, truncated: false }; };
  const destroy = vi.fn(async () => {});
  const stop = vi.fn(async () => { info.state = 'stopped'; });
  const computer = { id: info.id, info, refresh, start, stop, exec, destroy } as unknown as Computer;
  const ensure = async (key: string) => { activity.bindings.push(key); return computer; };
  const create = async (spec: unknown) => { activity.creations.push(spec); return computer; };
  const server = new HuskMcpServer({ ...options, manager: { ensure, create } as unknown as ComputerManager, logger: createLogger({ scope: 'test', level: 'silent' }) });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(b), client.connect(a)]);
  let closed = false;
  const disconnect = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
  };
  close.push(disconnect);
  const shell = () => client.callTool({ name: 'shell', arguments: { command: 'echo ok' } });
  return { activity, shell, info, start, stop, destroy, disconnect, refresh, exec, ensure, create };
}

describe('MCP reconnects', () => {
  it('separates the first isolation note from tool output', async () => {
    const s = await session();
    const first = await s.shell();
    if (!Array.isArray(first.content)) throw new Error('Expected MCP content array');
    expect(first.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/\n$/) });
    expect(first.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('ok') });
    expect(first.content.map((item) => item.text ?? '').join('')).toMatch(/\nok$/);

    const second = await s.shell();
    expect(second.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('resumes a cached computer before the next tool executes', async () => {
    const s = await session();
    await s.shell();
    s.info.state = 'stopped';
    expect((await s.shell()).isError).not.toBe(true);
    expect(s.activity.starts).toBe(1);
    expect(s.activity.creations).toHaveLength(1);
    expect(s.activity.executions).toBe(2);
  });

  it('coalesces concurrent checks and starts only once', async () => {
    const s = await session();
    await s.shell();
    s.info.state = 'stopped';
    await Promise.all([s.shell(), s.shell(), s.shell()]);
    expect(s.activity.starts).toBe(1);
  });

  it('reports a failed restart without dispatching or replaying the user command', async () => {
    const s = await session();
    await s.shell();
    s.info.state = 'stopped';
    s.start.mockRejectedValueOnce(new Error('Docker unavailable'));
    const result = await s.shell();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Docker unavailable');
    expect(s.activity.executions).toBe(1);
    expect((await s.shell()).isError).not.toBe(true);
    expect(s.activity.executions).toBe(2);
  });

  it('keeps independent MCP processes on separate default sessions', async () => {
    vi.stubEnv('HUSK_SESSION', undefined);
    const a = await session();
    const b = await session();
    await a.shell();
    await b.shell();
    expect(a.activity.creations[0]).not.toEqual(b.activity.creations[0]);
    expect(a.activity.bindings).toEqual([]);
    expect(b.activity.bindings).toEqual([]);
  });

  it('honours an explicitly configured shared session', async () => {
    vi.stubEnv('HUSK_SESSION', 'project');
    const s = await session();
    await s.shell();
    expect(s.activity.bindings).toEqual(['project']);
  });

  it.each(['option', 'environment'] as const)('stops and preserves a named ephemeral session configured by %s', async (via) => {
    if (via === 'environment') vi.stubEnv('HUSK_SESSION', 'saved-project');
    const s = await session({ ephemeral: true, ...(via === 'option' ? { sessionKey: 'saved-project' } : {}) });
    await s.shell();
    expect(s.activity.bindings).toEqual(['saved-project']);
    await s.disconnect();
    expect(s.stop).toHaveBeenCalledOnce();
    expect(s.destroy).not.toHaveBeenCalled();
    expect(s.info.state).toBe('stopped');
  });

  it('destroys an anonymous ephemeral session when it disconnects', async () => {
    const s = await session({ ephemeral: true });
    await s.shell();
    expect(s.activity.creations).toHaveLength(1);
    await s.disconnect();
    expect(s.destroy).toHaveBeenCalledOnce();
    expect(s.stop).not.toHaveBeenCalled();
  });

  it('leaves a non-ephemeral computer running', async () => {
    const s = await session({ ephemeral: false, sessionKey: 'long-running-project' });
    await s.shell();
    await s.disconnect();
    expect(s.destroy).not.toHaveBeenCalled();
    expect(s.stop).not.toHaveBeenCalled();
    expect(s.info.state).toBe('running');
  });
});
