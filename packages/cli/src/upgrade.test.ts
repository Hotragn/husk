import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@husk-ai/core';
import type { Computer, ComputerProvider } from '@husk-ai/core';
import { ComputerManager, decodeSpec, lastUsedTimes, loadInfos } from '@husk-ai/runtime';
import { loadSpec } from './lib/yaml.js';

/**
 * Someone coming from 0.1.4 keeps what they had. `fixtures/home-0.1.4` is a
 * ~/.husk as 0.1.4 wrote it: a chat's computer bound to its named session
 * (`HUSK_SESSION=proj`) with its files, a computer made with `husk up dev` on
 * ssh, and a registered bot (0.1.4's own example). Its absolute paths say
 * {{HOME}}, filled in with wherever the test puts it.
 */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'home-0.1.4');

/** How 0.1.4 labelled a chat's Docker computer: the engine keeps these, not ~/.husk. */
const LABELS_0_1_4 = {
  'husk.provider': 'docker',
  'husk.id': 'cmp_0a14ctr',
  'husk.key': 'proj',
  'husk.spec': 'eyJuYW1lIjoibWNwLXByb2oiLCJpZGxlVGltZW91dFNlYyI6MzYwMCwicGVyc2lzdCI6dHJ1ZSwiZmxhdm9yIjoicHl0aG9uIiwibGFiZWxzIjp7Imh1c2sua2V5IjoicHJvaiJ9fQ==',
};

let home = '';
const was = process.env.HUSK_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'husk-0.1.4-'));
  cpSync(FIXTURE, home, { recursive: true });
  // As a JSON string's contents, so a Windows path stays valid JSON.
  const at = JSON.stringify(home).slice(1, -1);
  for (const f of readdirSync(join(home, 'computers'))) {
    const file = join(home, 'computers', f);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('{{HOME}}', at));
  }
  process.env.HUSK_HOME = home;
});
afterEach(() => {
  if (was === undefined) delete process.env.HUSK_HOME;
  else process.env.HUSK_HOME = was;
  rmSync(home, { recursive: true, force: true });
});

describe('a ~/.husk that 0.1.4 wrote', () => {
  it('lists its computers as they were, with when each was last used', async () => {
    const infos = await loadInfos();
    expect(infos.map((i) => i.id).sort()).toEqual(['cmp_0a14dev', 'cmp_0a14proj']);
    expect(infos.find((i) => i.id === 'cmp_0a14dev')).toMatchObject({ name: 'dev', provider: 'ssh', spec: { flavor: 'python' } });
    expect((await lastUsedTimes()).get('cmp_0a14proj')).toBe('2026-09-20T08:15:00.000Z');
  });

  it('keeps a local computer’s files where its record says they are', async () => {
    const [proj] = await loadInfos('local');
    expect(readFileSync(join(proj?.spec.labels?.['husk.workspace'] ?? '', 'notes.txt'), 'utf8')).toBe('kept across the upgrade\n');
  });

  it('gives a named session its computer back, and makes no new one', async () => {
    const local: ComputerProvider = {
      name: 'local',
      priority: 10,
      description: "0.1.4's local computers",
      isAvailable: async () => ({ available: true, isolated: false }),
      list: () => loadInfos('local'),
      get: async (id) => {
        const info = (await loadInfos('local')).find((i) => i.id === id);
        return info ? ({ id, info, refresh: async () => info } as unknown as Computer) : null;
      },
      create: async () => {
        throw new Error('made a new computer instead of keeping the one bound to the session');
      },
    };
    const manager = new ComputerManager({ providers: [local], logger: createLogger({ scope: 'test', level: 'silent' }) });
    expect((await manager.ensure('proj', { provider: 'local' })).id).toBe('cmp_0a14proj');
  });

  it('reads the spec off a container 0.1.4 labelled, its session key included', () => {
    expect(decodeSpec(LABELS_0_1_4['husk.spec'])).toEqual({ name: 'mcp-proj', idleTimeoutSec: 3600, persist: true, flavor: 'python', labels: { 'husk.key': LABELS_0_1_4['husk.key'] } });
  });

  it('runs its registered bots with this release’s parser', async () => {
    expect(await loadSpec(join(home, 'husks', 'ci-triage', 'husk.yaml'))).toMatchObject({ name: 'ci-triage', model: 'sonnet' });
  });
});
