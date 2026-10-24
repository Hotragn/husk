import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePaths, paths } from '@husk-ai/core';
import type { ComputerInfo, ProviderName } from '@husk-ai/core';

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
  const p = paths(); // read-only: never creates ~/.husk
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
  const p = ensurePaths();
  await rm(join(p.computers, `${id}.json`), { force: true }).catch(() => {});
  await rm(join(p.computers, `${id}.used`), { force: true }).catch(() => {});
}

/* -----------------------------------------------------------------------------
   Last use, for the providers whose engine does not record it.

   Docker and Podman answer "what exists?" from their own labels, which is why
   nothing above is written for them. But no engine records when husk last ran
   a command: `docker inspect` offers `State.StartedAt`, and that is when the
   container booted, not when it was last used.

   Reaping on `StartedAt` would not be a weaker idle timeout, it would be a
   different feature wearing its name -- a container busy for twenty minutes
   under `idleTimeoutSec: 600` would be destroyed mid-command. So the one fact
   the engine cannot supply is kept here, in a file per computer, and the
   engine stays the source of truth for everything else.

   A timestamp per file rather than one shared map: two `husk exec`
   invocations in different processes write concurrently, and a shared file
   makes that a lost update.
-------------------------------------------------------------------------------- */

/** Record that a computer was used, now. Cheap enough for the exec path. */
export async function touchInfo(id: string, at = new Date()): Promise<void> {
  const p = ensurePaths();
  const target = join(p.computers, `${id}.used`);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, at.toISOString(), 'utf8');
  await rename(tmp, target);
}

/**
 * Last-use times by computer id.
 *
 * Absent for a computer husk has not run anything in since this was added, and
 * for any container created by an older version. The caller keeps whatever it
 * already had in that case, which is the conservative direction: a missing
 * record must never make something look idler than it is.
 */
export async function lastUsedTimes(): Promise<Map<string, string>> {
  const p = paths(); // read-only: never creates ~/.husk
  const out = new Map<string, string>();
  let files: string[];
  try {
    files = await readdir(p.computers);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.used')) continue;
    try {
      const at = (await readFile(join(p.computers, f), 'utf8')).trim();
      if (!Number.isNaN(Date.parse(at))) out.set(f.slice(0, -'.used'.length), at);
    } catch {
      // Unreadable means "no record", handled by the caller.
    }
  }
  return out;
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
