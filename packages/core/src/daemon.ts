import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePaths, paths } from './config.js';

/**
 * How a chat's MCP process finds the one local Husk that owns every computer's
 * browser, handoffs and activity.
 *
 * `husk serve` writes this file once it is listening and removes it on a clean
 * shutdown. It holds the control plane's token, so it is written owner-only,
 * like the rest of ~/.husk.
 */
export interface DaemonRecord {
  url: string;
  token: string | null;
  pid: number;
  version: string;
  startedAt: string;
}

export function daemonFile(): string {
  return join(paths().root, 'daemon.json');
}

/** The record, or undefined when there is none or it cannot be read. Never creates ~/.husk. */
export function readDaemonRecord(): DaemonRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(daemonFile(), 'utf8')) as Partial<DaemonRecord>;
    if (typeof parsed.url !== 'string' || typeof parsed.pid !== 'number' || typeof parsed.version !== 'string') return undefined;
    return {
      url: parsed.url,
      token: typeof parsed.token === 'string' ? parsed.token : null,
      pid: parsed.pid,
      version: parsed.version,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return undefined;
  }
}

/** Write-then-rename, owner-only. */
export function writeDaemonRecord(record: DaemonRecord): void {
  ensurePaths();
  const target = daemonFile();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
}

/** Remove the record, but only if it is still this process's: a newer daemon may have replaced it. */
export function clearDaemonRecord(pid = process.pid): void {
  if (readDaemonRecord()?.pid !== pid) return;
  rmSync(daemonFile(), { force: true });
}
