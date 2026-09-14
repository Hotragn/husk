import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOrphanedWorkspaces } from './providers/local.js';

/**
 * Workspaces that outlived their registry entry.
 *
 * `destroy()` used to swallow every `rm` failure, so a computer whose files
 * were still held open vanished from `husk ps` and left its workspace on disk
 * forever. A provisioned Chromium is 325 MB of that, and I found 1.9 GB of it
 * on a machine that reported no computers at all.
 */

let home: string | undefined;
const original = process.env.HUSK_HOME;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
  if (original === undefined) delete process.env.HUSK_HOME;
  else process.env.HUSK_HOME = original;
});

async function huskHomeWith(workspaceIds: string[], registeredIds: string[]) {
  home = await mkdtemp(join(tmpdir(), 'husk-orphan-'));
  process.env.HUSK_HOME = home;
  await mkdir(join(home, 'workspaces'), { recursive: true });
  await mkdir(join(home, 'computers'), { recursive: true });
  for (const id of workspaceIds) await mkdir(join(home, 'workspaces', id), { recursive: true });
  for (const id of registeredIds) {
    await writeFile(
      join(home, 'computers', `${id}.json`),
      JSON.stringify({
        id,
        name: id,
        provider: 'local',
        state: 'running',
        image: 'local:wsl',
        workdir: '/work',
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        spec: { provider: 'local', labels: { 'husk.workspace': join(home!, 'workspaces', id) } },
      }),
    );
  }
}

describe('findOrphanedWorkspaces', () => {
  it('finds a workspace whose registry entry is gone', async () => {
    await huskHomeWith(['cmp_alive', 'cmp_leaked'], ['cmp_alive']);
    const orphans = await findOrphanedWorkspaces();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toContain('cmp_leaked');
  });

  it('reports nothing when every workspace is accounted for', async () => {
    await huskHomeWith(['cmp_a', 'cmp_b'], ['cmp_a', 'cmp_b']);
    expect(await findOrphanedWorkspaces()).toEqual([]);
  });

  it('ignores directories that are not computers', async () => {
    await huskHomeWith(['cmp_x'], ['cmp_x']);
    await mkdir(join(home!, 'workspaces', 'scratch'), { recursive: true });
    expect(await findOrphanedWorkspaces()).toEqual([]);
  });

  it('returns paths rather than deleting, because reclaiming disk is the caller’s call', async () => {
    await huskHomeWith(['cmp_leaked'], []);
    const orphans = await findOrphanedWorkspaces();
    expect(orphans).toHaveLength(1);
    // still there -- the function reports, it does not sweep
    expect(await findOrphanedWorkspaces()).toHaveLength(1);
  });

  it('is empty when there is no workspaces directory at all', async () => {
    home = await mkdtemp(join(tmpdir(), 'husk-orphan-'));
    process.env.HUSK_HOME = home;
    expect(await findOrphanedWorkspaces()).toEqual([]);
  });
});
