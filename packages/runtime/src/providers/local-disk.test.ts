import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerInfo } from '@husk-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { localWorkspaceBytes } from './local.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const infoFor = (labels: Record<string, string>) => ({ id: 'cmp_x', spec: { labels } }) as unknown as ComputerInfo;

describe('localWorkspaceBytes', () => {
  it('adds up the files under the workspace, nested ones included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'husk-disk-'));
    dirs.push(root);
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'one.txt'), 'x'.repeat(100));
    writeFileSync(join(root, 'a', 'b', 'two.bin'), Buffer.alloc(2048));
    expect(await localWorkspaceBytes(infoFor({ 'husk.workspace': root }))).toBe(2148);
  });

  it('counts a missing workspace as empty, and does not guess inside WSL', async () => {
    expect(await localWorkspaceBytes(infoFor({ 'husk.workspace': join(tmpdir(), 'husk-no-such-dir-9f2') }))).toBe(0);
    expect(await localWorkspaceBytes(infoFor({ 'husk.wslWorkspace': '/home/u/w' }))).toBeUndefined();
  });
});
