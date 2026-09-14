import { HuskError, formatDuration } from '@husk/core';
import type { Computer, ComputerInfo } from '@husk/core';
import { ComputerManager } from '@husk/runtime';
import * as ui from '../ui.js';

/**
 * Everything the computer commands share.
 *
 * The manager is constructed lazily and once per process: building it registers
 * providers, and each provider's availability probe costs real time.
 */
let cached: ComputerManager | undefined;

export function manager(): ComputerManager {
  cached ??= new ComputerManager();
  return cached;
}

/**
 * Resolve `<name|id>` to a live machine.
 *
 * When it misses, the error lists what does exist -- a 404 that does not tell
 * you the right answer is a support ticket, and the answer is one `list()` away.
 */
export async function resolve(ref: string): Promise<Computer> {
  const mgr = manager();
  const direct = await mgr.get(ref);
  if (direct) return direct;

  const all = await mgr.list();
  const byName = all.filter((c) => c.name === ref || c.id === ref || c.id.startsWith(ref));
  if (byName.length === 1) {
    const found = await mgr.get((byName[0] as ComputerInfo).id);
    if (found) return found;
  }
  if (byName.length > 1) {
    throw new HuskError('E_COMPUTER_NOT_FOUND', `"${ref}" matches ${byName.length} computers`, {
      hint: `use the full id: ${byName.map((c) => c.id).join(', ')}`,
    });
  }

  throw new HuskError('E_COMPUTER_NOT_FOUND', `no computer named "${ref}"`, {
    hint: all.length
      ? `running now: ${all.map((c) => c.name).join(', ')}`
      : 'there are no computers yet — create one with `husk up`',
  });
}

export function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function stateColor(state: string): string {
  if (state === 'running') return ui.green(state);
  if (state === 'error') return ui.red(state);
  if (state === 'creating') return ui.cyan(state);
  return ui.dim(state);
}

export { formatDuration };
