import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Computer, ComputerInfo, ComputerProvider } from '@husk-ai/core';
import { ComputerManager } from './manager.js';
import { ensureRunning } from './readiness.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'husk-readiness-'));
  vi.stubEnv('HUSK_HOME', home);
  await mkdir(join(home, 'computers'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

function machine(state: ComputerInfo['state'] = 'stopped') {
  const info = { id: 'cmp_resume', state } as ComputerInfo;
  const activity = { starts: 0, refreshes: 0, creates: 0 };
  const start = vi.fn(async () => { activity.starts++; info.state = 'running'; });
  const refresh = vi.fn(async () => { activity.refreshes++; return info; });
  const computer = { id: info.id, info, start, refresh } as unknown as Computer;
  const create = vi.fn(async () => { activity.creates++; return computer; });
  const provider = {
    name: 'fake', priority: 1, description: 'test provider',
    get: vi.fn(async () => computer), create,
    list: async () => [], isAvailable: async () => ({ available: true }),
  } satisfies ComputerProvider;
  return { activity, computer, info, start, refresh, create, manager: new ComputerManager({ providers: [provider] }) };
}

async function bind() {
  await writeFile(join(home, 'computers', 'bindings.json'), JSON.stringify({ chat: 'cmp_resume' }));
}

describe('computer readiness', () => {
  it('resumes the bound computer without replacing its workspace', async () => {
    await bind();
    const m = machine();
    expect(await m.manager.ensure('chat')).toBe(m.computer);
    expect(m.activity.starts).toBe(1);
    expect(m.activity.refreshes).toBe(2);
    expect(m.activity.creates).toBe(0);
  });

  it('coalesces concurrent reconnects before reading the binding', async () => {
    await bind();
    const m = machine();
    await Promise.all(Array.from({ length: 5 }, () => m.manager.ensure('chat')));
    expect(m.activity.starts).toBe(1);
  });

  it('coalesces first use before creating a computer', async () => {
    const m = machine('running');
    await Promise.all(Array.from({ length: 5 }, () => m.manager.ensure('new')));
    expect(m.activity.creates).toBe(1);
  });

  it('leaves a running computer alone', async () => {
    const m = machine('running');
    expect(await ensureRunning(m.computer)).toBe(m.computer);
    expect(m.activity.starts).toBe(0);
  });

  it('does not claim success when start returns but the computer stays stopped', async () => {
    const m = machine();
    m.start.mockImplementation(async () => {});
    await expect(ensureRunning(m.computer)).rejects.toMatchObject({ code: 'E_COMPUTER_FAILED' });
  });

  it.each(['paused', 'error', 'destroyed', 'creating'] as const)('reports %s without replacing the computer', async state => {
    const m = machine(state);
    await expect(ensureRunning(m.computer)).rejects.toThrow(state);
    expect(m.activity.starts).toBe(0);
    expect(m.activity.creates).toBe(0);
  });

  it('keeps the binding after a failed start and retries on the next call', async () => {
    await bind();
    const m = machine();
    m.start.mockRejectedValueOnce(new Error('daemon unavailable'));
    await expect(m.manager.ensure('chat')).rejects.toThrow('daemon unavailable');
    expect(await m.manager.ensure('chat')).toBe(m.computer);
    expect(m.activity.creates).toBe(0);
  });

  it('propagates inspection failures without starting or replacing anything', async () => {
    const m = machine();
    m.refresh.mockRejectedValueOnce(new Error('permission denied'));
    await expect(ensureRunning(m.computer)).rejects.toThrow('permission denied');
    expect(m.activity.starts).toBe(0);
  });
});
