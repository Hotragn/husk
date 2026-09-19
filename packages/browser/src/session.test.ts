import { describe, expect, it } from 'vitest';
import { isHuskError } from '@husk-ai/core';
import type { Computer, ComputerInfo, ExecResult, NetworkPolicy, ProviderName } from '@husk-ai/core';
import { BrowserSession, warnIfDebugPortIsExposed } from './session.js';

/**
 * A computer that refuses to do anything.
 *
 * Every assertion here is about the policy gate, which runs *before* the
 * browser is touched -- so "the exec never happened" is the proof that a denied
 * navigation never reached the network, and is not an incidental detail.
 */
function fakeComputer(provider: ProviderName, network?: NetworkPolicy): Computer & { execs: number } {
  const info = {
    id: 'c1',
    name: 'c1',
    provider,
    state: 'running',
    image: 'none',
    workdir: '/work',
    createdAt: '',
    lastUsedAt: '',
    spec: { ...(network ? { network } : {}) },
  } as ComputerInfo;

  const fail = (): never => {
    throw new Error('the browser was launched, which this test did not expect');
  };

  const computer = {
    id: 'c1',
    info,
    execs: 0,
    async exec(): Promise<ExecResult> {
      computer.execs++;
      return fail();
    },
  } as unknown as Computer & { execs: number };
  return computer;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (err) {
    return isHuskError(err) ? err.code : `plain: ${(err as Error).message}`;
  }
}

describe('a failed Chromium launch', () => {
  it('is bounded, reports the browser log, and reaps the failed process', async () => {
    const info = {
      id: 'browser-failure',
      name: 'browser-failure',
      provider: 'docker',
      state: 'running',
      image: 'none',
      workdir: '/work',
      createdAt: '',
      lastUsedAt: '',
      spec: { network: { mode: 'full' } },
    } as ComputerInfo;
    const calls: Array<{ cmd: string; timeoutSec?: number }> = [];
    const computer = {
      id: info.id,
      info,
      async exec(input: { cmd: string; timeoutSec?: number }): Promise<ExecResult> {
        calls.push(input);
        if (input.cmd.includes('command -v chromium')) {
          return { exitCode: 0, stdout: '/usr/bin/chromium\n', stderr: '', durationMs: 1, truncated: false, timedOut: false };
        }
        if (input.cmd.includes('--version')) {
          return { exitCode: 0, stdout: 'Chromium 140.0\n', stderr: '', durationMs: 1, truncated: false, timedOut: false };
        }
        if (input.cmd.includes('python3 -c "import socket')) {
          return { exitCode: 0, stdout: '43123\n', stderr: '', durationMs: 1, truncated: false, timedOut: false };
        }
        if (input.cmd.includes('for i in $(seq 1 80)')) {
          return { exitCode: 1, stdout: '', stderr: '', durationMs: 40_000, truncated: false, timedOut: false };
        }
        if (input.cmd.includes('pkill -f')) {
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, truncated: false, timedOut: false };
        }
        throw new Error(`unexpected command: ${input.cmd}`);
      },
      async readTextFile(): Promise<string> {
        return 'missing libnss3.so';
      },
    } as unknown as Computer;

    let caught: unknown;
    try {
      await new BrowserSession(computer, { idleTimeoutMs: 0 }).activePage();
    } catch (err) {
      caught = err;
    }

    expect(isHuskError(caught) && caught.code).toBe('E_COMPUTER_FAILED');
    expect((caught as Error).message).toMatch(/waited up to 90 seconds/);
    expect(JSON.stringify(caught)).toContain('missing libnss3.so');

    const poll = calls.find((call) => call.cmd.includes('for i in $(seq 1 80)'));
    expect(poll?.timeoutSec).toBe(90);
    const cleanup = calls.find((call) => call.cmd.includes('pkill -f'));
    expect(cleanup?.cmd).toContain('--remote-debugging-port=43123');
    expect(cleanup?.timeoutSec).toBe(15);
  });
});

describe('navigation is subject to the computer’s network policy', () => {
  it('refuses a host outside an egress allow-list before opening a socket', async () => {
    const c = fakeComputer('local', { mode: 'egress', allow: ['example.com'] });
    const s = new BrowserSession(c);
    expect(await codeOf(() => s.goto('https://evil.test/'))).toBe('E_EXEC_DENIED');
    expect(c.execs).toBe(0);
  });

  it('refuses the cloud metadata endpoint even in mode: full', async () => {
    const c = fakeComputer('docker', { mode: 'full' });
    const s = new BrowserSession(c);
    expect(await codeOf(() => s.goto('http://169.254.169.254/latest/meta-data/'))).toBe('E_EXEC_DENIED');
    expect(c.execs).toBe(0);
  });

  it('refuses mode: none outright', async () => {
    const c = fakeComputer('docker', { mode: 'none' });
    expect(await codeOf(() => new BrowserSession(c).goto('https://example.com'))).toBe('E_EXEC_DENIED');
  });

  it('refuses file:// -- a real browser would happily read the host disk', async () => {
    const c = fakeComputer('docker', { mode: 'full' });
    expect(await codeOf(() => new BrowserSession(c).goto('file:///etc/passwd'))).toBe('E_EXEC_DENIED');
    expect(c.execs).toBe(0);
  });

  it('refuses something that is not a URL at all', async () => {
    const c = fakeComputer('docker', { mode: 'full' });
    expect(await codeOf(() => new BrowserSession(c).goto('example.com'))).toBe('E_EXEC_DENIED');
  });
});

describe('loopback follows the provider, exactly as browseInComputer does', () => {
  it('refuses localhost on `local`, where loopback is the host’s own', async () => {
    const c = fakeComputer('local', { mode: 'full' });
    expect(await codeOf(() => new BrowserSession(c).goto('http://127.0.0.1:8080/'))).toBe('E_EXEC_DENIED');
    expect(c.execs).toBe(0);
  });

  it('refuses localhost on `ssh` for the same reason', async () => {
    const c = fakeComputer('ssh', { mode: 'full' });
    expect(await codeOf(() => new BrowserSession(c).goto('http://localhost:3000/'))).toBe('E_EXEC_DENIED');
  });

  it('allows localhost on docker, where the agent’s own dev server lives', async () => {
    const c = fakeComputer('docker', { mode: 'full' });
    // Past the gate, so it goes on to launch a browser -- which this fake
    // refuses to do. Any code but E_EXEC_DENIED means the policy let it through.
    expect(await codeOf(() => new BrowserSession(c).goto('http://127.0.0.1:3000/'))).not.toBe('E_EXEC_DENIED');
    expect(c.execs).toBeGreaterThan(0);
  });

  it('lets an operator name loopback explicitly on `local`', async () => {
    const c = fakeComputer('local', { mode: 'egress', allow: ['127.0.0.1'] });
    expect(await codeOf(() => new BrowserSession(c).goto('http://127.0.0.1:3000/'))).not.toBe('E_EXEC_DENIED');
  });
});

describe('an explicit policy overrides the computer’s', () => {
  it('applies the override, not the spec', async () => {
    const c = fakeComputer('docker', { mode: 'full' });
    const s = new BrowserSession(c, { network: { mode: 'egress', allow: ['example.com'] } });
    expect(await codeOf(() => s.goto('https://evil.test/'))).toBe('E_EXEC_DENIED');
  });
});

describe('warnIfDebugPortIsExposed', () => {
  const fakeComputer = (provider: string, id = 'cmp_' + provider) =>
    ({ id, info: { provider } }) as unknown as Parameters<typeof warnIfDebugPortIsExposed>[0];

  it('stays quiet on providers that own their network namespace', () => {
    // docker, podman and fly contain the port; there is nothing to warn about.
    for (const p of ['docker', 'podman', 'fly']) {
      const said: string[] = [];
      warnIfDebugPortIsExposed(fakeComputer(p), 9222, (m) => said.push(m));
      expect(said, `${p} should not warn`).toEqual([]);
    }
  });

  it('warns on a provider that shares the host network stack', () => {
    // WSL2 forwards loopback listeners to Windows on its own, so "husk did not
    // publish it" is not the same as "nothing else can reach it".
    const said: string[] = [];
    warnIfDebugPortIsExposed(fakeComputer('local', 'cmp_a'), 41234, (m) => said.push(m));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/no authentication/);
    expect(said[0]).toMatch(/41234/);
    expect(said[0]).toMatch(/docker, podman or fly/);
  });

  it('warns about ssh too, where the remote box is somebody else machine', () => {
    const said: string[] = [];
    warnIfDebugPortIsExposed(fakeComputer('ssh', 'cmp_b'), 5000, (m) => said.push(m));
    expect(said).toHaveLength(1);
  });

  it('says it once per computer, not once per launch', () => {
    // A warning printed on every call is a warning nobody reads.
    const said: string[] = [];
    const c = fakeComputer('local', 'cmp_repeat');
    warnIfDebugPortIsExposed(c, 1, (m) => said.push(m));
    warnIfDebugPortIsExposed(c, 1, (m) => said.push(m));
    warnIfDebugPortIsExposed(c, 1, (m) => said.push(m));
    expect(said).toHaveLength(1);
  });
});
