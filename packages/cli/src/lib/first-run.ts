import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { huskHome } from '@husk/core';
import * as ui from '../ui.js';

/**
 * The first sixty seconds.
 *
 * Someone running `husk up` for the first time deserves to know three things
 * before anything happens: which provider they are about to get, whether it is
 * actually isolated, and that nothing is being sent anywhere. Saying it once, up
 * front, is honest. Saying it on every run is noise people learn to skip.
 */
const MARKER = '.oriented';

export function hasBeenOriented(): boolean {
  return existsSync(join(huskHome(), MARKER));
}

function markOriented(): void {
  const home = huskHome();
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, MARKER), new Date().toISOString() + '\n', 'utf8');
  } catch {
    // A read-only HOME is someone else's problem; it must not stop the command.
  }
}

export interface Orientation {
  provider: string;
  isolated: boolean | null;
  detail?: string;
  hint?: string;
}

/**
 * Print the orientation once. Always to stderr, so `--json` on a first run is
 * still a clean pipe.
 */
export function orient(o: Orientation): void {
  if (hasBeenOriented()) return;
  markOriented();

  const home = huskHome();
  ui.note('');
  ui.note(ui.bold('Welcome to husk.') + ui.dim(' This runs once.'));
  ui.note('');
  ui.note(`  ${ui.dim('provider  ')} ${o.provider}${o.detail ? ui.dim(' — ' + o.detail) : ''}`);
  ui.note(
    o.isolated
      ? `  ${ui.dim('isolation ')} ${ui.green('kernel-level')} ${ui.dim('(namespaces, cgroups)')}`
      : `  ${ui.dim('isolation ')} ${ui.yellow('none')} ${ui.dim('— guardrails, not a sandbox. A determined process can escape.')}`,
  );
  ui.note(`  ${ui.dim('privacy   ')} nothing leaves this machine except calls to a model provider you configure`);
  ui.note(`  ${ui.dim('state     ')} ${home} ${ui.dim('(delete it to reset husk completely)')}`);
  if (o.hint) ui.note(`  ${ui.dim('next      ')} ${o.hint}`);
  ui.note('');
}
