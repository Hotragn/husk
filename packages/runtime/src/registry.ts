import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePaths } from '@husk/core';
import type { ComputerInfo, ProviderName } from '@husk/core';

/**
 * The on-disk record of computers whose provider cannot answer "what exists?"
 * on its own.
 *
 * Docker and Podman can: their engines hold the labels. A directory on a remote
 * box and a Fly machine cannot tell us the spec they were created with, so we
 * keep a JSON file per computer under `~/.husk/computers`.
 */

/** Write-then-rename, so a crash mid-write cannot leave a half-parsed entry. */
export async function persistInfo(info: ComputerInfo): Promise<void> {
  const p = ensurePaths();
  const target = join(p.computers, `${info.id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2), 'utf8');
  await rename(tmp, target);
}

export async function loadInfos(provider?: ProviderName): Promise<ComputerInfo[]> {
  const p = ensurePaths();
  let files: string[];
  try {
    files = await readdir(p.computers);
  } catch {
    return [];
  }
  const out: ComputerInfo[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'bindings.json') continue;
    try {
      const info = JSON.parse(await readFile(join(p.computers, f), 'utf8')) as ComputerInfo;
      if (!provider || info.provider === provider) out.push(info);
    } catch {
      // A corrupt entry is dropped rather than crashing `husk ps`.
    }
  }
  return out;
}

export async function forgetInfo(id: string): Promise<void> {
  await rm(join(ensurePaths().computers, `${id}.json`), { force: true }).catch(() => {});
}

/** Ids whose idle or lifetime budget has run out. */
export function expired(infos: ComputerInfo[], now = Date.now()): ComputerInfo[] {
  return infos.filter((info) => {
    const idle = info.spec.idleTimeoutSec ?? 0;
    const life = info.spec.maxLifetimeSec ?? 0;
    const idleFor = (now - new Date(info.lastUsedAt).getTime()) / 1000;
    const aliveFor = (now - new Date(info.createdAt).getTime()) / 1000;
    return (idle > 0 && idleFor > idle) || (life > 0 && aliveFor > life);
  });
}
