import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComputerInfo } from '@husk-ai/core';
import { EXEC_TAG, REAP_SCRIPT, STOP_UNCONFIRMED, newExecTag, reapArgv, timerMs } from './reap.js';
import { OciComputer, type OciConfig } from './providers/oci-common.js';

describe('timerMs', () => {
  it('means no timer for nothing, zero, negative or not a number', () => {
    for (const sec of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(timerMs(sec)).toBeUndefined();
  });

  it('caps at what setTimeout can hold, so a huge timeout is not an instant kill', () => {
    expect(timerMs(2)).toBe(2000);
    expect(timerMs(60 * 60 * 24 * 365)).toBe(2_147_483_647);
  });
});

describe('the reaper', () => {
  it('is plain sh, run with the tag as $1 and a name ps can show', () => {
    const tag = newExecTag();
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(reapArgv(tag)).toEqual(['/bin/sh', '-c', REAP_SCRIPT, 'husk-reap', tag]);
    expect(REAP_SCRIPT).toContain(`${EXEC_TAG}=$1`);
  });

  // The real thing, against real processes: Linux has /proc, like every computer.
  it.runIf(process.platform === 'linux')('kills every process carrying the tag, and nothing else', async () => {
    const tag = newExecTag();
    const tagged = spawn('/bin/sh', ['-c', 'sleep 300 & sleep 300'], { env: { ...process.env, [EXEC_TAG]: tag }, stdio: 'ignore', detached: true });
    const other = spawn('/bin/sh', ['-c', 'sleep 300'], { env: { ...process.env, [EXEC_TAG]: newExecTag() }, stdio: 'ignore', detached: true });
    await new Promise((r) => setTimeout(r, 300));
    try {
      const killed = Number(execFileSync('/bin/sh', ['-c', REAP_SCRIPT, 'husk-reap', tag], { encoding: 'utf8' }).trim());
      // Both sleeps, and the shell unless it exec'd the last one.
      expect(killed).toBeGreaterThanOrEqual(2);
      const exited = await new Promise<boolean>((r) => {
        if (tagged.exitCode !== null || tagged.signalCode !== null) r(true);
        tagged.on('exit', () => r(true));
        setTimeout(() => r(false), 3000);
      });
      expect(exited).toBe(true);
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
    } finally {
      for (const p of [tagged, other]) {
        try {
          process.kill(-(p.pid as number), 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });
});

// A stand-in for the docker CLI: `exec` of the command sleeps, the reaper's own
// exec is recorded, and every call is logged so the test can see the tag travel.
const posix = process.platform !== 'win32';
describe.runIf(posix)('a stopped docker exec', () => {
  let dir = '';
  let home: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'husk-reap-'));
    home = process.env.HUSK_HOME;
    process.env.HUSK_HOME = join(dir, 'home');
  });

  afterAll(() => {
    if (home === undefined) delete process.env.HUSK_HOME;
    else process.env.HUSK_HOME = home;
    rmSync(dir, { recursive: true, force: true });
  });

  let engines = 0;
  /** A fresh fake engine, with its own call log at `.log`. */
  function fakeEngine(reapExit: number): OciConfig & { log: string } {
    engines += 1;
    const log = join(dir, `calls-${engines}.log`);
    const bin = join(dir, `docker-${engines}`);
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${log}'`,
        'case "$*" in',
        `  *husk-reap*) exit ${reapExit} ;;`,
        '  *) exec sleep 30 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    return { binary: bin, provider: 'docker', rootless: false, log };
  }

  function computer(cfg: OciConfig): OciComputer {
    const now = new Date().toISOString();
    const info = {
      id: 'cmp_reaptest',
      nativeId: 'fake-container',
      provider: 'docker',
      state: 'running',
      image: 'debian:bookworm-slim',
      workdir: '/work',
      createdAt: now,
      lastUsedAt: now,
      spec: {},
    } as unknown as ComputerInfo;
    return new OciComputer(cfg, info);
  }

  it('kills the command inside the container, not only the client', async () => {
    const cfg = fakeEngine(0);
    const r = await computer(cfg).exec({ cmd: 'sleep 300', timeoutSec: 1 });
    expect(r.timedOut).toBe(true);
    const calls = readFileSync(cfg.log, 'utf8').trim().split('\n');
    const tag = /HUSK_EXEC=([0-9a-f]{16})/.exec(calls[0] ?? '')?.[1];
    expect(tag).toBeDefined();
    expect(calls.some((c) => c.includes('husk-reap') && c.endsWith(tag as string) && c.includes('fake-container'))).toBe(true);
    expect(r.stderr).not.toContain(STOP_UNCONFIRMED);
  });

  it('says so when it could not confirm the command stopped', async () => {
    const r = await computer(fakeEngine(1)).exec({ cmd: 'sleep 300', timeoutSec: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.stderr).toContain(STOP_UNCONFIRMED);
  });

  it('stops on an abort as well as on a timeout', async () => {
    const cfg = fakeEngine(0);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await computer(cfg).exec({ cmd: 'sleep 300', timeoutSec: 60, signal: ac.signal });
    expect(r.timedOut).toBe(true);
    expect(readFileSync(cfg.log, 'utf8')).toContain('husk-reap');
  });
});
