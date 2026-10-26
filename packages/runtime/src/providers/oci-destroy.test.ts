import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComputerInfo } from '@husk-ai/core';

const calls = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile: (_binary: string, args: string[], _opts: unknown, callback: Function) => {
    calls.push(args);
    callback(undefined, { stdout: '', stderr: '' });
  } };
});
import { OciComputer, volumeName } from './oci-common.js';

// The computer's record is forgotten on destroy: in a home of the test's own.
const home = mkdtempSync(join(tmpdir(), 'husk-destroy-'));
beforeAll(() => vi.stubEnv('HUSK_HOME', home));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
afterEach(() => { calls.length = 0; });

const chat = { persist: true, labels: { 'husk.key': 'chat:claude-code:abc' } } as ComputerInfo['spec'];
function computer(spec: ComputerInfo['spec']) {
  return new OciComputer({ binary: 'docker', provider: 'docker', rootless: false }, {
    id: 'cmp_test', nativeId: 'native', state: 'running', spec,
  } as ComputerInfo);
}

describe('deleting a computer', () => {
  it('keeps a chat’s files for its next computer: `husk rm` means "stop for now"', async () => {
    await computer(chat).destroy();
    expect(calls).toEqual([['rm', '-f', 'native']]);
  });

  it('erases them when the console deletes it: the volume, browser profile and logins included', async () => {
    await computer(chat).destroy({ erase: true });
    expect(calls).toEqual([['rm', '-f', '-v', 'native'], ['volume', 'rm', volumeName('cmp_test', chat)]]);
  });

  it('takes a computer of its own with it either way', async () => {
    await computer({ persist: true } as ComputerInfo['spec']).destroy();
    expect(calls).toEqual([['rm', '-f', '-v', 'native'], ['volume', 'rm', 'husk-cmp_test']]);
  });
});
