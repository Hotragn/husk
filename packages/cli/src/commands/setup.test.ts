import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatApp } from '@husk-ai/core';
import type { DoctorProbes, ProviderRow } from './doctor.js';
import { pickApps, recommended, run } from './setup.js';
import * as ui from '../ui.js';

const row = (name: string, available: boolean, isolated: boolean | null): ProviderRow =>
  ({ name, description: name, priority: 1, available, isolated }) as ProviderRow;

const app = (id: ChatApp['id'], found: boolean): ChatApp => ({ id, name: id, found, connected: false, where: '', after: '' });

describe('husk setup choices', () => {
  it('recommends an isolated computer over an unisolated one, and an available one over either', () => {
    expect(recommended([row('local', true, false), row('docker', true, true)])?.name).toBe('docker');
    expect(recommended([row('docker', false, true), row('local', true, false)])?.name).toBe('local');
    expect(recommended([row('docker', false, true)])).toBeUndefined();
  });

  it('takes "all" to mean the apps found here, and refuses an app it does not know', () => {
    const apps = [app('cursor', true), app('vscode', false), app('claude-desktop', true)];
    expect(pickApps('all', apps)).toEqual(['cursor', 'claude-desktop']);
    expect(pickApps('vscode', apps)).toEqual(['vscode']);
    expect(() => pickApps('chatgpt', apps)).toThrow(/unknown app: chatgpt/);
  });
});

describe('husk setup, unattended', () => {
  const probes: DoctorProbes = {
    providerStatus: async () => [
      { name: 'local', description: 'x', priority: 10, available: true, isolated: false, isolationKind: 'guardrails' },
      { name: 'docker', description: 'x', priority: 50, available: false, isolated: true, reason: 'daemon not reachable', hint: 'start Docker Desktop' },
    ],
    modelProviders: async () => [],
    orphanedWorkspaces: async () => [],
    windowsDegradation: async () => null,
  };
  afterEach(() => vi.restoreAllMocks());

  it('refuses a computer that is not available, and says how to fix it', async () => {
    const fails: string[] = [];
    vi.spyOn(ui, 'fail').mockImplementation((l) => void fails.push(l));
    vi.spyOn(ui, 'hint').mockImplementation(() => {});
    vi.spyOn(ui, 'print').mockImplementation(() => {});
    expect(await run(['--computer', 'docker', '--apps', '', '--no-start'], probes)).toBe(2);
    expect(fails[0]).toContain('daemon not reachable');
  });

  it('reports the plan as JSON, changing nothing when no app is chosen', async () => {
    const out: unknown[] = [];
    vi.spyOn(ui, 'json').mockImplementation((v) => void out.push(v));
    vi.spyOn(ui, 'print').mockImplementation(() => {});
    expect(await run(['--computer', 'local', '--apps', '', '--no-start', '--json'], probes)).toBe(0);
    expect(out[0]).toMatchObject({
      provider: 'local',
      flavor: null,
      launch: { command: 'npx', args: ['-y', '@husk-ai/mcp', '--provider', 'local'] },
      results: [],
    });
  });
});
