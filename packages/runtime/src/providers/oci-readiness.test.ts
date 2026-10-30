import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerInfo } from '@husk-ai/core';

const cli = vi.hoisted(() => ({ stdout: '', error: undefined as Error | undefined }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile: (_binary: string, _args: string[], _opts: unknown, callback: Function) => {
    callback(cli.error, { stdout: cli.stdout, stderr: '' });
  } };
});
import { OciComputer } from './oci-common.js';
import { DockerProvider } from './docker.js';

afterEach(() => { cli.stdout = ''; cli.error = undefined; vi.unstubAllGlobals(); });

function computer() {
  return new OciComputer({ binary: 'docker', provider: 'docker', rootless: false }, {
    id: 'cmp_test', nativeId: 'native', state: 'running', spec: {},
  } as ComputerInfo);
}

describe('container inspection', () => {
  it('reads stopped state from the engine instead of trusting the cache', async () => {
    cli.stdout = JSON.stringify([{ State: { Running: false, Status: 'exited' } }]);
    expect((await computer().refresh()).state).toBe('stopped');
  });

  it('recognises a removed container', async () => {
    cli.error = Object.assign(new Error('inspect failed'), { stderr: 'Error: No such object: native' });
    expect((await computer().refresh()).state).toBe('destroyed');
  });

  it.each(['permission denied', 'Cannot connect to the Docker daemon'])('does not treat %s as deletion', async message => {
    cli.error = Object.assign(new Error('inspect failed'), { stderr: message });
    const c = computer();
    await expect(c.refresh()).rejects.toMatchObject({ code: 'E_COMPUTER_FAILED', hint: expect.stringContaining('husk doctor') });
    expect(c.info.state).toBe('running');
  });
});

describe('Docker access guidance', () => {
  it('gives platform-appropriate guidance for access denied', async () => {
    cli.error = Object.assign(new Error('permission denied'), { stderr: 'permission denied' });
    const result = await new DockerProvider().isAvailable();
    expect(result.available).toBe(false);
    expect(result.hint).toContain(process.platform === 'win32' ? 'Windows account' : 'socket permissions');
    if (process.platform === 'win32') expect(result.hint).not.toContain('sudo');
  });
});
