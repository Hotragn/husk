import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComputerInfo } from '@husk-ai/core';
import { OciComputer } from './oci-common.js';

/**
 * A container's file read stops where it runs: one `read_file /dev/zero` must
 * not grow the shared Husk until it dies. The stand-in docker runs what would
 * run in the container, here: the same `timeout` and `head` (Linux has both).
 */
describe.runIf(process.platform === 'linux')('a file read in a container', () => {
  let dir = '';
  let computer: OciComputer;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'husk-read-'));
    const bin = join(dir, 'docker');
    writeFileSync(bin, ['#!/bin/sh', '# exec <container> <command...>', 'shift 2', 'exec "$@"', ''].join('\n'));
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, 'small.txt'), 'hello');
    const now = new Date().toISOString();
    const info = {
      id: 'cmp_readtest',
      nativeId: 'fake-container',
      provider: 'docker',
      state: 'running',
      image: 'x',
      workdir: '/work',
      createdAt: now,
      lastUsedAt: now,
      spec: {},
    } as unknown as ComputerInfo;
    computer = new OciComputer({ binary: bin, provider: 'docker', rootless: false }, info);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a file that fits, byte for byte', async () => {
    expect(Buffer.from(await computer.readFile(join(dir, 'small.txt'))).toString()).toBe('hello');
  });

  it('refuses /dev/zero at its limit instead of reading for ever', async () => {
    const started = Date.now();
    await expect(computer.readFile('/dev/zero', { maxBytes: 4096 })).rejects.toMatchObject({ code: 'E_QUOTA' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('shows the start of an endless file as text, and says there is more', async () => {
    const text = await computer.readTextFile('/dev/zero', 16);
    expect(text.startsWith('\0'.repeat(16))).toBe(true);
    expect(text).toContain('goes on past 16 bytes');
  });

  it('says a missing file is missing', async () => {
    await expect(computer.readFile(join(dir, 'nope'))).rejects.toMatchObject({ code: 'E_FS_DENIED' });
  });
});
