import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalProvider, windowsHint, windowsReason } from './local.js';
import type { ShellPlan } from './local.js';
import type { Computer } from '@husk-ai/core';

/**
 * The local provider's workspace contract, exercised the way an agent hits it:
 * write through the file tools, then read and execute through the shell using
 * the same documented /work path.
 *
 * The shell side of this was broken on posix hosts: file tools translated
 * /work, the shell did not, so "write a script, then run it" -- the most
 * basic agent workflow -- failed on the default provider.
 */

let home: string | undefined;
const original = process.env.HUSK_HOME;
const computers: Computer[] = [];

/**
 * Remove the scratch HUSK_HOME, allowing for a filesystem that is still settling.
 *
 * Each test has just had a provider writing under `computers/`, and teardown can
 * start before the last of those writes has landed -- `rm` then loses the race
 * and reports `ENOTEMPTY: directory not empty, rmdir`. Seen on macos-latest for
 * 0f664b6. `maxRetries` is Node's answer: with `recursive`, it backs off linearly
 * and retries exactly that error set (EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM).
 * `force` alone does not help -- it suppresses "does not exist", not "is busy".
 *
 * This is the same fix #80 applied to `packages/cli/src/smoke.test.ts`, including
 * the part that matters most: teardown cannot fail the run. Every assertion has
 * already passed by the time this runs, the directory is under the OS temp dir,
 * and a CI runner is discarded whole. The warning keeps a leak visible rather
 * than silent.
 */
async function removeHome(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.warn(`[local.test] could not remove ${dir}: ${(err as Error).message}`);
  }
}

afterEach(async () => {
  for (const c of computers.splice(0)) await c.destroy().catch(() => {});
  if (home) await removeHome(home);
  home = undefined;
  if (original === undefined) delete process.env.HUSK_HOME;
  else process.env.HUSK_HOME = original;
});

async function freshComputer(): Promise<Computer> {
  home = await mkdtemp(join(tmpdir(), 'husk-local-'));
  process.env.HUSK_HOME = home;
  await mkdir(join(home, 'computers'), { recursive: true });
  const c = await new LocalProvider().create({});
  computers.push(c);
  return c;
}

// The /work contract is a posix-and-WSL promise; the cmd.exe fallback reports
// its own truthful workdir instead and is covered by the degradation tests.
describe.skipIf(process.platform === 'win32')('local provider /work contract', () => {
  it('runs a script written through the file tools via its /work path', async () => {
    const c = await freshComputer();
    await c.writeFile('/work/hello.sh', 'echo marker-from-work\n');

    const r = await c.exec({ cmd: 'sh /work/hello.sh' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('marker-from-work');

    // And the file tools still see the same file the shell just ran.
    const back = Buffer.from(await c.readFile('/work/hello.sh')).toString('utf8');
    expect(back).toBe('echo marker-from-work\n');
  });

  it('sees files the shell wrote to /work through the file tools', async () => {
    const c = await freshComputer();
    const w = await c.exec({ cmd: 'printf shell-made > /work/out.txt' });
    expect(w.exitCode).toBe(0);
    expect(Buffer.from(await c.readFile('/work/out.txt')).toString('utf8')).toBe('shell-made');
  });

  it('maps /tmp to the computer tmp the file tools use', async () => {
    const c = await freshComputer();
    await c.writeFile('/tmp/setup.sh', 'echo tmp-marker\n');
    const r = await c.exec({ cmd: 'sh /tmp/setup.sh' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('tmp-marker');
  });

  it('starts the shell in the workspace and says so in $PWD', async () => {
    const c = await freshComputer();
    const r = await c.exec({ cmd: 'pwd && echo "PWD=$PWD" && printf rel > relative.txt && cat /work/relative.txt' });
    expect(r.exitCode).toBe(0);
    // The relative write landed in the workspace and reads back through /work.
    expect(r.stdout).toContain('rel');
    const [pwdLine, envLine] = r.stdout.split('\n');
    expect(envLine).toBe(`PWD=${pwdLine}`);
  });

  it('does not repoint a guest path that escapes the jail', async () => {
    const c = await freshComputer();
    const r = await c.exec({ cmd: 'cat /work/../../etc/passwd' });
    expect(r.exitCode).not.toBe(0);
  });
});

/**
 * The isolation claim and the Windows messaging, which run on every platform.
 *
 * These are literals and pure functions, so they belong outside the /work
 * contract block above -- that one is posix-only, and skipping it on Windows
 * would otherwise take the honesty invariant with it. The build contract says
 * the local provider is guardrails only and never to claim isolation it does
 * not provide, and `husk doctor` renders whatever `isAvailable()` returns. A
 * boolean flipped here would quietly tell someone their prompt-injected agent
 * was sandboxed.
 */
describe('the local provider', () => {
  it('is always available, because the free path depends on it', async () => {
    const a = await new LocalProvider().isAvailable();
    expect(a.available).toBe(true);
  });

  it('never claims isolation it does not have', async () => {
    const a = await new LocalProvider().isAvailable();
    expect(a.isolated).toBe(false);
    expect(a.isolationKind).toBe('guardrails');
  });

  it('names the mechanism rather than saying "not isolated" and stopping', async () => {
    const a = await new LocalProvider().isAvailable();
    // "Isolated" on its own is meaningless, and so is its negation: a user who
    // reads "not isolated" still does not know what to do about it.
    expect(a.reason).toBeTruthy();
    expect(a.hint).toBeTruthy();
    expect(`${a.reason} ${a.hint}`).toMatch(/guard|sandbox|Docker|wsl/i);
  });

  it('does not advertise isolation in its own description', async () => {
    const p = new LocalProvider();
    expect(p.description).toMatch(/not isolated/i);
    expect(p.priority).toBe(10);
  });

  /**
   * Taken as plans rather than through `isAvailable()`, because reaching the
   * degraded states for real means breaking WSL on the machine running the
   * test. The states themselves are set in one place, `detectShell`, from a
   * single fact: whether `wsl.exe -l -q` listed a distro.
   */
  describe('what it tells a Windows user', () => {
    const plan = (degradation?: 'wsl-broken' | 'wsl-absent'): ShellPlan => ({
      kind: degradation ? 'windows' : 'wsl',
      degradation,
      label: 'irrelevant to these assertions',
    });

    it('does not tell someone to install the WSL they already have', () => {
      // The "install Docker" bug, one provider over: a fix naming a step the
      // user has already taken reads as the tool not having looked.
      expect(windowsHint(plan('wsl-broken'))).toMatch(/wsl --shutdown/);
      expect(windowsHint(plan('wsl-broken'))).not.toMatch(/wsl --install/);
      expect(windowsHint(plan('wsl-absent'))).toMatch(/wsl --install/);
    });

    it('does not claim WSL is absent from a machine that has it', () => {
      // `reason` used to be one hardcoded sentence saying "with no WSL" for
      // both states, printed directly beneath a `version` line that said WSL
      // was installed and not responding. Two answers, adjacent lines.
      expect(windowsReason(plan('wsl-broken'))).toMatch(/installed but not answering/);
      expect(windowsReason(plan('wsl-broken'))).not.toMatch(/no WSL/);
      expect(windowsReason(plan('wsl-absent'))).toMatch(/no WSL/);
    });

    it('says nothing when the shell is a real Linux one', () => {
      expect(windowsReason(plan())).toBeNull();
      expect(windowsHint(plan())).toBeNull();
    });
  });
});
