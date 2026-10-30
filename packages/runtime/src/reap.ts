import { randomBytes } from 'node:crypto';

/**
 * Stopping a command where it actually runs.
 *
 * Killing the client that started a command -- `docker exec`, `ssh`, `wsl.exe` --
 * does not kill the command: the engine, the remote sshd and the distro all
 * keep it running. So every exec carries a tag in its environment, inherited by
 * everything it starts, and a stop runs a second command in the same computer
 * that kills every process carrying that tag. The browser's reaper works the
 * same way for its scripts (`REAP_SOURCE` in @husk-ai/browser).
 *
 * It needs only `sh`, `tr` and `grep`, which even the slim images have, and
 * Linux's /proc. Where there is no /proc (a macOS ssh host) it says so rather
 * than reporting a kill it could not do. A process that scrubs its own
 * environment and calls setsid escapes it; that is the honest limit.
 */
export const EXEC_TAG = 'HUSK_EXEC';

/** A fresh tag for one exec. */
export function newExecTag(): string {
  return randomBytes(8).toString('hex');
}

/** `$1` is the tag. Prints how many processes it killed; exits 3 where it cannot look. */
export const REAP_SCRIPT = [
  '[ -r /proc/self/environ ] || { echo unsupported; exit 3; }',
  `t="${EXEC_TAG}=$1"; n=0`,
  'for f in /proc/[0-9]*/environ; do',
  `  if tr '\\000' '\\n' < "$f" 2>/dev/null | grep -qx -- "$t"; then`,
  '    p=${f#/proc/}; p=${p%/environ}',
  '    if kill -9 "$p" 2>/dev/null; then n=$((n+1)); fi',
  '  fi',
  'done',
  'echo "$n"',
].join('\n');

/** The argv that runs the reaper for `tag`. `husk-reap` is `$0`, so it shows in `ps`. */
export function reapArgv(tag: string): string[] {
  return ['/bin/sh', '-c', REAP_SCRIPT, 'husk-reap', tag];
}

/** Appended to a stopped command's stderr when the stop could not be confirmed. */
export const STOP_UNCONFIRMED =
  '[husk] the command may still be running inside the computer: stopping it could not be confirmed';

/**
 * A timer delay in ms for `sec` seconds, or undefined for none. Node fires a
 * delay over 2^31-1 ms (about 24.8 days) after 1 ms instead, which turned an
 * absurd timeout into an instant kill.
 */
export function timerMs(sec: number | undefined): number | undefined {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return undefined;
  return Math.min(sec * 1000, 2_147_483_647);
}
