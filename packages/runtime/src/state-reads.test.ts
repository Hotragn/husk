import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lastUsedTimes, loadInfos } from './registry.js';
import { ComputerManager } from './manager.js';
import { findOrphanedWorkspaces } from './providers/local.js';

const original = process.env.HUSK_HOME;
let parent: string | undefined;

afterEach(async () => {
  if (original === undefined) delete process.env.HUSK_HOME;
  else process.env.HUSK_HOME = original;
  if (parent) await rm(parent, { recursive: true, force: true });
  parent = undefined;
});

// #111: `husk doctor` printed "not created yet" and then created ~/.husk,
// because the read paths it walks all went through ensurePaths().
describe('reading state never creates ~/.husk', () => {
  it('leaves a missing HUSK_HOME missing', async () => {
    parent = await mkdtemp(join(tmpdir(), 'husk-reg-'));
    const home = join(parent, 'never-made');
    process.env.HUSK_HOME = home;

    expect(await loadInfos()).toEqual([]);
    expect((await lastUsedTimes()).size).toBe(0);
    expect(await findOrphanedWorkspaces()).toEqual([]);
    expect(await new ComputerManager({ providers: [] }).keyFor('cmp_x')).toBeUndefined();

    expect(existsSync(home)).toBe(false);
  });
});
