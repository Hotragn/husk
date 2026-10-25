import { describe, expect, it } from 'vitest';
import { HuskError } from '@husk-ai/core';
import type { Computer, ComputerInfo, ExecResult, ProviderName } from '@husk-ai/core';
import type { CdpTransport, DriverRequest, DriverResult } from './cdp.js';
import { BrowserSession } from './session.js';

/**
 * A browser that stops comes back, and a launch that fails leaves no Chromium
 * behind. No Chromium here: a computer that says "Chromium is installed and
 * up" on a new port for every launch, and transports that can be told
 * Chromium has gone.
 */

const ok = (stdout = '', exitCode = 0): ExecResult => ({ exitCode, stdout, stderr: '', durationMs: 1, truncated: false, timedOut: false });

function fakeComputer(provider: ProviderName = 'docker', launch: (cmd: string) => ExecResult = () => ok()) {
  const info = { id: 'recover-1', name: 'recover-1', provider, state: 'running', image: 'none', workdir: '/work', createdAt: '', lastUsedAt: '', spec: {} } as ComputerInfo;
  let port = 43000;
  const computer = {
    id: info.id,
    info,
    cmds: [] as string[],
    async exec(input: { cmd: string | string[] }): Promise<ExecResult> {
      const cmd = Array.isArray(input.cmd) ? input.cmd.join(' ') : input.cmd;
      computer.cmds.push(cmd);
      if (cmd.includes('command -v chromium')) return ok('/usr/bin/chromium\n');
      if (cmd.includes('--version')) return ok('Chromium 140.0\n');
      if (cmd.includes('import socket')) return ok(`${++port}\n`);
      if (cmd.includes('setsid')) return launch(cmd);
      return ok();
    },
  };
  return computer;
}

/** Chromium as the driver finds it: up, or gone. */
function fakeTransport(chromium: { up: boolean }) {
  const t = {
    closed: false,
    async run(req: DriverRequest): Promise<DriverResult> {
      if (!chromium.up) throw new HuskError('E_COMPUTER_FAILED', 'nothing is listening on the debug port', { details: { kind: 'unreachable' } });
      return { results: req.steps.map((s) => (s.op === 'send' && s.method === 'Target.createTarget' ? { targetId: 'T1' } : {})) };
    },
    async close(): Promise<void> {
      t.closed = true;
    },
  };
  return t;
}

const at = (cmds: string[], ...parts: string[]) => cmds.findIndex((c) => parts.every((p) => c.includes(p)));

describe('a browser that stops', () => {
  it('fails the call that finds Chromium gone, and the next call starts a new one, the old one killed first', async () => {
    const computer = fakeComputer();
    const chromium = { up: true };
    const transports: Array<ReturnType<typeof fakeTransport>> = [];
    const session = new BrowserSession(computer as unknown as Computer, {
      idleTimeoutMs: 0,
      transport: () => {
        const t = fakeTransport(chromium);
        transports.push(t);
        return t as unknown as CdpTransport;
      },
    });
    const first = await session.activePage();
    chromium.up = false;
    await expect(first.evaluate('1')).rejects.toThrow(/nothing is listening/);
    chromium.up = true;
    const second = await session.activePage();
    expect(second).not.toBe(first);
    expect(transports).toHaveLength(2);
    expect(transports[0]!.closed).toBe(true);
    // A Chromium that is wedged rather than gone goes too, before the new one starts.
    const killed = at(computer.cmds, 'pkill', '--remote-debugging-port=43001');
    expect(killed).toBeGreaterThan(-1);
    expect(at(computer.cmds, 'setsid', '--remote-debugging-port=43002')).toBeGreaterThan(killed);
  });

  it('kills a Chromium that started but could not be driven, so a failed launch leaves none behind', async () => {
    const computer = fakeComputer();
    const chromium = { up: false };
    const session = new BrowserSession(computer as unknown as Computer, { idleTimeoutMs: 0, transport: () => fakeTransport(chromium) as unknown as CdpTransport });
    await expect(session.activePage()).rejects.toThrow(/nothing is listening/);
    expect(at(computer.cmds, 'pkill', '--remote-debugging-port=43001')).toBeGreaterThan(-1);
    // And the next call starts afresh.
    chromium.up = true;
    await session.activePage();
    expect(at(computer.cmds, 'setsid', '--remote-debugging-port=43002')).toBeGreaterThan(-1);
  });

  it('kills a Chromium whose sandbox could not run before starting one without it', async () => {
    // On a provider that shares the host's network, Chromium keeps its own sandbox where it can.
    const computer = fakeComputer('local', (cmd) => (cmd.includes('--no-sandbox --remote') ? ok() : ok('', 3)));
    const session = new BrowserSession(computer as unknown as Computer, { idleTimeoutMs: 0, transport: () => fakeTransport({ up: true }) as unknown as CdpTransport });
    await session.activePage();
    const killed = at(computer.cmds, 'pkill', '--remote-debugging-port=43001');
    expect(killed).toBeGreaterThan(-1);
    expect(at(computer.cmds, '--no-sandbox --remote-debugging-port=43002')).toBeGreaterThan(killed);
  });
});
