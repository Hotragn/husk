import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Computer, ComputerInfo, ExecResult } from '@husk-ai/core';
import type { CdpTransport, DriverRequest, DriverResult, ScreencastEvent, ScreenFrame } from './cdp.js';
import { BrowserSession, browserFor, closeBrowserFor, markUsedFor } from './session.js';

/**
 * The shared screencast, and what counts as using the computer, with no
 * Chromium: a computer whose execs say "Chromium is installed and up", and a
 * transport that records casts and lets the test push frames.
 */

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, truncated: false, timedOut: false });

function fakeComputer(): Computer & { used: number } {
  const info = { id: 'screen-1', name: 'screen-1', provider: 'docker', state: 'running', image: 'none', workdir: '/work', createdAt: '', lastUsedAt: '', spec: {} } as ComputerInfo;
  const computer = {
    id: info.id,
    info,
    used: 0,
    markUsed() {
      computer.used++;
    },
    async exec(input: { cmd: string }): Promise<ExecResult> {
      if (input.cmd.includes('command -v chromium')) return ok('/usr/bin/chromium\n');
      if (input.cmd.includes('--version')) return ok('Chromium 140.0\n');
      if (input.cmd.includes('import socket')) return ok('43123\n');
      return ok();
    },
  } as unknown as Computer & { used: number };
  return computer;
}

function fakeTransport(pushes = true) {
  let listener: ((e: ScreencastEvent) => void) | undefined;
  const t = {
    pushes,
    casts: [] as Array<{ targetId: string; fps: number }>,
    stops: [] as string[],
    async run(req: DriverRequest): Promise<DriverResult> {
      return { results: req.steps.map((s) => (s.op === 'send' && s.method === 'Target.createTarget' ? { targetId: 'T1' } : {})) };
    },
    async close(): Promise<void> {},
    async screencast(targetId: string, fps: number): Promise<boolean> {
      if (!t.pushes) return false;
      t.casts.push({ targetId, fps });
      return true;
    },
    async stopScreencast(targetId: string): Promise<void> {
      t.stops.push(targetId);
    },
    onScreencast(fn: (e: ScreencastEvent) => void) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    end(reason: string) {
      listener?.({ type: 'ended', reason });
    },
    push(targetId: string, data: string) {
      listener?.({ type: 'frame', targetId, frame: { data, width: 800, height: 600 } });
    },
  };
  return t;
}

async function launched(pushes = true) {
  const computer = fakeComputer();
  const transport = fakeTransport(pushes);
  const session = new BrowserSession(computer, { idleTimeoutMs: 0, transport: () => transport as CdpTransport });
  await session.activePage();
  return { computer, transport, session };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the shared screencast', () => {
  it('starts one cast at the fastest rate asked for, and stops it when the last viewer leaves', async () => {
    const { transport, session } = await launched();
    const stopA = await session.watchScreen(1, () => undefined);
    const stopB = await session.watchScreen(4, () => undefined);
    expect(transport.casts).toEqual([
      { targetId: 'T1', fps: 1 },
      { targetId: 'T1', fps: 4 },
    ]);
    stopB!();
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.casts.at(-1)).toEqual({ targetId: 'T1', fps: 1 });
    stopA!();
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.stops).toEqual(['T1']);
  });

  it('holds each viewer to its own rate, and always ends on the newest frame', async () => {
    const { transport, session } = await launched();
    vi.useFakeTimers();
    const slow: string[] = [];
    const fast: string[] = [];
    await session.watchScreen(1, (f) => slow.push(f.data));
    await session.watchScreen(4, (f) => fast.push(f.data));
    transport.push('T1', 'a');
    await vi.advanceTimersByTimeAsync(300);
    transport.push('T1', 'b');
    await vi.advanceTimersByTimeAsync(300);
    transport.push('T1', 'c');
    // The page went still. The slow viewer must not be left on "a".
    await vi.advanceTimersByTimeAsync(2000);
    expect(fast).toEqual(['a', 'b', 'c']);
    expect(slow).toEqual(['a', 'c']);
  });

  it('shows a new viewer the last frame at once, since a still page sends no more', async () => {
    const { transport, session } = await launched();
    await session.watchScreen(4, () => undefined);
    transport.push('T1', 'still');
    const seen: ScreenFrame[] = [];
    await session.watchScreen(1, (f) => seen.push(f));
    expect(seen.map((f) => f.data)).toEqual(['still']);
  });

  it('hands viewers back to poll when pushing stops for good after it started', async () => {
    // The driver died and its replacement fell back to one exec per call: a
    // viewer left waiting for pushed frames would stare at one frame forever.
    const { transport, session } = await launched();
    vi.useFakeTimers();
    const stopped = vi.fn();
    expect(await session.watchScreen(4, () => undefined, stopped)).toBeTypeOf('function');
    transport.pushes = false;
    transport.end('the browser driver exited');
    await vi.advanceTimersByTimeAsync(1500);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('says it cannot push, so the caller polls, when the transport cannot cast', async () => {
    const { session } = await launched(false);
    expect(await session.watchScreen(4, () => undefined)).toBeUndefined();
  });
});

describe('what counts as using the computer', () => {
  it('a tool call does; watching the screen and taking a frame do not', async () => {
    const { computer, session } = await launched();
    const afterLaunch = computer.used;
    expect(afterLaunch).toBeGreaterThan(0);
    await session.watchScreen(4, () => undefined);
    await session.livePage()!.frame().catch(() => undefined);
    expect(computer.used).toBe(afterLaunch);
    await session.activePage();
    expect(computer.used).toBe(afterLaunch + 1);
  });

  it('a person’s input does, through markUsedFor', async () => {
    const computer = fakeComputer();
    browserFor(computer);
    markUsedFor(computer.id);
    expect(computer.used).toBe(1);
    markUsedFor('no-such-computer');
    await closeBrowserFor(computer.id);
  });
});
