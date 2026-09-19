import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { huskHome } from '@husk-ai/core';
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

export function markOriented(): void {
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

/**
 * Orientation for the commands that do not pick a provider themselves.
 *
 * `up` knows which provider it is about to use and says so precisely. `run`,
 * `serve` and `mcp` reach a computer lazily or not at all, and they used to say
 * nothing -- so someone whose first command was `husk mcp` got the whole
 * isolation story never, which is the worst possible audience to miss: a model
 * is about to be handed a shell on their machine.
 *
 * This is the cheap version. It probes nothing, because these commands are on a
 * latency path and a provider probe shells out to docker; it points at the
 * command that does. It still runs once and once only.
 */
export function orientBriefly(next: string): void {
  if (hasBeenOriented()) return;
  markOriented();
  ui.note('');
  ui.note(ui.bold('Welcome to husk.') + ui.dim(' This runs once.'));
  ui.note('');
  ui.note(`  ${ui.dim('privacy   ')} nothing leaves this machine except calls to a model provider you configure`);
  ui.note(`  ${ui.dim('isolation ')} depends on the provider, and not every one of them is a sandbox`);
  ui.note(`  ${ui.dim('check it  ')} ${ui.cyan('husk doctor')} ${ui.dim('names yours and says which')}`);
  ui.note(`  ${ui.dim('guided    ')} ${ui.cyan('husk onboard')} ${ui.dim('walks the whole setup in five steps')}`);
  ui.note(`  ${ui.dim('next      ')} ${next}`);
  ui.note('');
}
