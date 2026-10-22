import { describe, expect, it, vi } from 'vitest';
import { HuskError, isHuskError } from '@husk-ai/core';
import type { Computer, ComputerProcess, ExecRequest, ExecResult, SpawnRequest } from '@husk-ai/core';
import { CdpConnection, ComputerDriverTransport, DRIVER_SCRATCH_PATH, createTarget, waitResultOf } from './cdp.js';
import type { CdpTransport, DriverRequest, DriverResult } from './cdp.js';
import { DRIVER_SOURCE } from './driver.js';

/**
 * Every test here runs with no browser, no Python and no computer.
 *
 * That is the whole reason the transport is an interface: the transport is the
 * only part that needs a machine, and the parts above it -- batching, the
 * result contract, and the error taxonomy that tells a caller what to do next
 * -- are the parts that break silently if nobody checks them.
 */

interface FakeComputer extends Computer {
  /** Driver invocations only -- the install exec is filtered out. */
  calls: ExecRequest[];
  installs: string[];
  writes: Array<{ path: string; content: unknown; mode?: string }>;
  writeFails: boolean;
  /** Whether `cat > /dev/shm/...` succeeds, i.e. whether the fast path exists. */
  scratchWritable: boolean;
}

function fakeExec(handler: (req: ExecRequest) => Partial<ExecResult>): FakeComputer {
  const computer = {
    id: 'c1',
    calls: [] as ExecRequest[],
    installs: [] as string[],
    writes: [] as Array<{ path: string; content: unknown; mode?: string }>,
    writeFails: false,
    scratchWritable: true,
    async exec(req: ExecRequest): Promise<ExecResult> {
      const base = { stdout: '', stderr: '', durationMs: 1, truncated: false, timedOut: false };
      if (typeof req.cmd === 'string' && req.cmd.startsWith('cat > ')) {
        if (!computer.scratchWritable) return { ...base, exitCode: 1, stderr: 'Read-only file system' };
        computer.installs.push(DRIVER_SCRATCH_PATH);
        return { ...base, exitCode: 0 };
      }
      computer.calls.push(req);
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        truncated: false,
        timedOut: false,
        ...handler(req),
      };
    },
    async writeFile(path: string, content: unknown, opts?: { mode?: string }): Promise<void> {
      if (computer.writeFails) throw new Error('read-only file system');
      computer.installs.push(path);
      computer.writes.push({ path, content, ...(opts?.mode ? { mode: opts.mode } : {}) });
    },
  } as unknown as FakeComputer;
  return computer;
}

/** A computer whose driver always succeeds, returning `results`. */
function okComputer(results: unknown[], extra: Record<string, unknown> = {}) {
  return fakeExec(() => ({ stdout: JSON.stringify({ ok: true, results, ...extra }) }));
}

/** A computer whose driver always reports this structured failure. */
function failComputer(kind: string, message = 'it went wrong', details: Record<string, unknown> = {}) {
  return fakeExec(() => ({ stdout: JSON.stringify({ ok: false, kind, message, details }) }));
}

function stdinOf(req: ExecRequest): Record<string, unknown> {
  return JSON.parse(req.stdin ?? '{}') as Record<string, unknown>;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (err) {
    return isHuskError(err) ? err.code : `plain: ${(err as Error).message}`;
  }
}

/** A transport that records requests and replays canned results. */
function fakeTransport(results: unknown[] = []): CdpTransport & { seen: DriverRequest[]; closed: boolean } {
  const t = {
    seen: [] as DriverRequest[],
    closed: false,
    async run(req: DriverRequest): Promise<DriverResult> {
      t.seen.push(req);
      return { results: results.length ? results : req.steps.map(() => ({})) };
    },
    async close(): Promise<void> {
      t.closed = true;
    },
  };
  return t;
}

describe('CdpConnection batching', () => {
  it('passes the steps through verbatim and returns one result per step', async () => {
    const t = fakeTransport([{ a: 1 }, { b: 2 }]);
    const conn = new CdpConnection(t);
    const out = await conn.run([
      { op: 'send', method: 'Page.enable', session: true },
      { op: 'send', method: 'Page.navigate', params: { url: 'https://a.test' }, session: true },
    ]);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
    expect(t.seen[0]?.steps).toHaveLength(2);
    expect(t.seen[0]?.steps[1]).toMatchObject({ method: 'Page.navigate', params: { url: 'https://a.test' } });
  });

  it('carries the target id, which is the only routing that survives a reconnect', async () => {
    const t = fakeTransport();
    await new CdpConnection(t).run([{ op: 'send', method: 'DOM.enable', session: true }], { targetId: 'T1' });
    expect(t.seen[0]?.targetId).toBe('T1');
  });

  it('sends a browser-level command with no target and no session routing', async () => {
    const t = fakeTransport([{ targetId: 'T9' }]);
    const conn = new CdpConnection(t);
    expect(await createTarget(conn, 'about:blank')).toBe('T9');
    expect(t.seen[0]?.targetId).toBeUndefined();
    expect(t.seen[0]?.steps[0]).toMatchObject({ method: 'Target.createTarget', session: false });
  });

  it('applies the default timeout, and lets a call override it', async () => {
    const t = fakeTransport();
    const conn = new CdpConnection(t, { timeoutMs: 5000 });
    await conn.run([{ op: 'send', method: 'Page.enable' }]);
    await conn.run([{ op: 'send', method: 'Page.enable' }], { timeoutMs: 90_000 });
    expect(t.seen.map((r) => r.timeoutMs)).toEqual([5000, 90_000]);
  });

  it('refuses to silently mis-align results when the driver returns the wrong number', async () => {
    const t = fakeTransport([{ only: 1 }]);
    const conn = new CdpConnection(t);
    expect(await codeOf(() => conn.run([{ op: 'send', method: 'A' }, { op: 'send', method: 'B' }]))).toBe('E_INTERNAL');
  });

  it('refuses new commands after close, instead of reopening the browser behind the caller', async () => {
    const t = fakeTransport();
    const conn = new CdpConnection(t);
    await conn.close('the browser session was closed');
    expect(t.closed).toBe(true);
    await expect(conn.send('DOM.enable')).rejects.toThrow(/cannot call DOM.enable/);
  });

  it('names the wait it refused, not just "a command"', async () => {
    const conn = new CdpConnection(fakeTransport());
    await conn.close('gone');
    await expect(conn.run([{ op: 'wait', event: 'Page.loadEventFired' }])).rejects.toThrow(/Page.loadEventFired/);
  });

  it('closing twice is not an error, because idle close and explicit close race', async () => {
    const conn = new CdpConnection(fakeTransport());
    await conn.close();
    await expect(conn.close()).resolves.toBeUndefined();
  });
});

describe('waitResultOf', () => {
  it('reads a fired event and its params', () => {
    expect(waitResultOf({ fired: true, params: { timestamp: 1 } })).toEqual({ fired: true, params: { timestamp: 1 } });
  });

  it('treats anything that is not an explicit fire as not fired', () => {
    expect(waitResultOf({ fired: false })).toEqual({ fired: false });
    expect(waitResultOf({ skipped: true })).toEqual({ fired: false });
    expect(waitResultOf(undefined)).toEqual({ fired: false });
    expect(waitResultOf('nonsense')).toEqual({ fired: false });
  });
});

describe('ComputerDriverTransport invokes the driver inside the computer', () => {
  it('installs the driver once and runs it with python3', async () => {
    const c = okComputer([{}]);
    const t = new ComputerDriverTransport(c, 9222);
    await t.run({ steps: [{ op: 'send', method: 'Page.enable' }] });
    await t.run({ steps: [{ op: 'send', method: 'Page.enable' }] });

    expect(c.installs).toEqual([DRIVER_SCRATCH_PATH]);
    expect(c.calls[0]?.cmd).toEqual(['python3', DRIVER_SCRATCH_PATH]);
    expect(c.calls[1]?.cmd).toEqual(['python3', DRIVER_SCRATCH_PATH]);
  });

  it('puts the driver on tmpfs, not on the persistent volume', async () => {
    // Measured: CPython reading an 18 KB script from a Windows-mapped /work
    // costs ~700ms per invocation against ~0 from tmpfs. The driver is
    // disposable; the 150 MB Chromium beside it is not.
    const c = okComputer([{}]);
    await new ComputerDriverTransport(c, 9222).run({ steps: [{ op: 'send', method: 'A' }] });
    expect(c.installs[0]).toBe('/dev/shm/husk-browser-driver.py');
  });

  it('falls back to the persistent path when tmpfs is not writable', async () => {
    const c = okComputer([{}]);
    c.scratchWritable = false;
    await new ComputerDriverTransport(c, 9222).run({ steps: [{ op: 'send', method: 'A' }] });
    expect(c.writes[0]?.path).toBe('/work/.husk-browser/driver.py');
    expect(c.writes[0]?.content).toBe(DRIVER_SOURCE);
    expect(c.calls[0]?.cmd).toEqual(['python3', '/work/.husk-browser/driver.py']);
  });

  it('honours an explicitly pinned path over both', async () => {
    const c = okComputer([{}]);
    await new ComputerDriverTransport(c, 9222, { driverPath: '/opt/d.py' }).run({
      steps: [{ op: 'send', method: 'A' }],
    });
    expect(c.writes[0]?.path).toBe('/opt/d.py');
    expect(c.calls[0]?.cmd).toEqual(['python3', '/opt/d.py']);
  });

  it('feeds the request on stdin, with the port the browser is on', async () => {
    const c = okComputer([{}]);
    await new ComputerDriverTransport(c, 41234).run({
      steps: [{ op: 'send', method: 'Page.enable', session: true }],
      targetId: 'T1',
      timeoutMs: 12_000,
    });
    expect(stdinOf(c.calls[0]!)).toMatchObject({ port: 41234, targetId: 'T1', timeoutMs: 12_000 });
  });

  it('reads output well past the provider default, because a screenshot is megabytes', async () => {
    const c = okComputer([{}]);
    await new ComputerDriverTransport(c, 9222).run({ steps: [{ op: 'send', method: 'Page.captureScreenshot' }] });
    expect(c.calls[0]?.maxOutputBytes).toBeGreaterThan(16 * 1024 * 1024);
  });

  it('gives the exec a looser deadline than the driver, so the driver reports the timeout', async () => {
    const c = okComputer([{}]);
    await new ComputerDriverTransport(c, 9222).run({ steps: [{ op: 'send', method: 'A' }], timeoutMs: 30_000 });
    expect(c.calls[0]?.timeoutSec).toBeGreaterThan(30);
  });

  it('caches the websocket url the driver discovered, and offers it back', async () => {
    const c = okComputer([{}], { ws: 'ws://127.0.0.1:9222/devtools/browser/abc' });
    const t = new ComputerDriverTransport(c, 9222);
    await t.run({ steps: [{ op: 'send', method: 'A' }] });
    await t.run({ steps: [{ op: 'send', method: 'A' }] });
    expect(stdinOf(c.calls[0]!)['ws']).toBeUndefined();
    expect(stdinOf(c.calls[1]!)['ws']).toBe('ws://127.0.0.1:9222/devtools/browser/abc');
  });

  it('forgets the cached websocket on close, because the next browser is a different one', async () => {
    const c = okComputer([{}], { ws: 'ws://127.0.0.1:9222/devtools/browser/abc' });
    const t = new ComputerDriverTransport(c, 9222);
    await t.run({ steps: [{ op: 'send', method: 'A' }] });
    await t.close();
    await t.run({ steps: [{ op: 'send', method: 'A' }] });
    expect(stdinOf(c.calls[1]!)['ws']).toBeUndefined();
  });
});

describe('the driver failure taxonomy survives the trip back', () => {
  const cases: Array<[string, string]> = [
    ['unreachable', 'E_COMPUTER_FAILED'],
    ['browser_gone', 'E_COMPUTER_FAILED'],
    ['timeout', 'E_EXEC_TIMEOUT'],
    ['protocol', 'E_TOOL_ERROR'],
    ['bad_target', 'E_TOOL_ERROR'],
    ['internal', 'E_INTERNAL'],
  ];

  for (const [kind, code] of cases) {
    it(`maps ${kind} onto ${code}`, async () => {
      const t = new ComputerDriverTransport(failComputer(kind), 9222);
      expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe(code);
    });
  }

  it('keeps the driver’s own message and its details', async () => {
    const c = failComputer('protocol', "Page.navigate: 'X' wasn't found", { code: -32601 });
    const t = new ComputerDriverTransport(c, 9222);
    try {
      await t.run({ steps: [{ op: 'send', method: 'X' }] });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as HuskError;
      expect(e.message).toMatch(/wasn't found/);
      expect(e.details).toMatchObject({ kind: 'protocol', code: -32601 });
      expect(e.hint).toBeTruthy();
    }
  });

  it('treats an unknown kind as a husk bug rather than guessing', async () => {
    const t = new ComputerDriverTransport(failComputer('something-new'), 9222);
    expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe('E_INTERNAL');
  });
});

describe('a driver that could not run is a different problem from a browser that failed', () => {
  it('reports a non-zero exit with the stderr, not as a browser error', async () => {
    const c = fakeExec(() => ({ exitCode: 127, stderr: 'python3: command not found' }));
    const t = new ComputerDriverTransport(c, 9222);
    expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe('E_EXEC_FAILED');
  });

  it('reinstalls the driver once when the script is missing, then succeeds', async () => {
    let attempt = 0;
    const c = fakeExec(() => {
      attempt++;
      return attempt === 1
        ? { exitCode: 2, stderr: "python3: can't open file '/work/.husk-browser/driver.py': No such file or directory" }
        : { stdout: JSON.stringify({ ok: true, results: [{}] }) };
    });
    const t = new ComputerDriverTransport(c, 9222);
    await expect(t.run({ steps: [{ op: 'send', method: 'A' }] })).resolves.toMatchObject({ results: [{}] });
    expect(c.installs).toHaveLength(2);
  });

  it('gives up after one reinstall rather than looping on a broken filesystem', async () => {
    const c = fakeExec(() => ({ exitCode: 2, stderr: 'No such file or directory' }));
    const t = new ComputerDriverTransport(c, 9222);
    expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe('E_EXEC_FAILED');
    expect(c.installs).toHaveLength(2);
  });

  it('says so when the driver printed something that is not JSON', async () => {
    const c = fakeExec(() => ({ stdout: 'Welcome to Ubuntu!\n{"ok": true}' }));
    const t = new ComputerDriverTransport(c, 9222);
    expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe('E_EXEC_FAILED');
  });

  it('refuses truncated output rather than parsing a screenshot with a hole in it', async () => {
    const c = fakeExec(() => ({ stdout: JSON.stringify({ ok: true, results: [{}] }), truncated: true }));
    const t = new ComputerDriverTransport(c, 9222);
    expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe('E_EXEC_FAILED');
  });

  it('reports the exec timing out as a timeout, not as malformed output', async () => {
    const c = fakeExec(() => ({ exitCode: 124, timedOut: true }));
    const t = new ComputerDriverTransport(c, 9222);
    expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe('E_EXEC_TIMEOUT');
  });

  it('reports a computer that cannot exec at all as a computer failure', async () => {
    const c = fakeExec(() => ({}));
    c.exec = async (): Promise<ExecResult> => {
      throw new Error('container is not running');
    };
    const t = new ComputerDriverTransport(c, 9222);
    expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe('E_COMPUTER_FAILED');
  });

  it('reports a computer that cannot be written to, and retries the install next time', async () => {
    const c = okComputer([{}]);
    c.scratchWritable = false;
    c.writeFails = true;
    const t = new ComputerDriverTransport(c, 9222);
    expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe('E_COMPUTER_FAILED');
    c.writeFails = false;
    c.scratchWritable = true;
    await expect(t.run({ steps: [{ op: 'send', method: 'A' }] })).resolves.toMatchObject({ results: [{}] });
  });
});

describe('createTarget', () => {
  it('fails loudly when Chromium answers without a target id', async () => {
    const conn = new CdpConnection(fakeTransport([{ somethingElse: true }]));
    expect(await codeOf(() => createTarget(conn))).toBe('E_EXEC_FAILED');
  });
});

/**
 * A computer that can hold a process open, playing the long-lived driver:
 * each line in is a request, and `answer` decides what goes back.
 */
function spawningComputer(
  answer: (req: Record<string, unknown>, out: (obj: unknown) => void, exit: (code: number) => void) => void,
  opts: { exitOnKill?: boolean } = {},
) {
  const c = okComputer([{ oneShot: true }]) as FakeComputer & { spawns: SpawnRequest[]; lines: string[]; used: number; kills: number };
  c.spawns = [];
  c.lines = [];
  c.used = 0;
  c.kills = 0;
  (c as { markUsed?: () => void }).markUsed = () => {
    c.used++;
  };
  (c as { spawn?: Computer['spawn'] }).spawn = (req: SpawnRequest): ComputerProcess => {
    c.spawns.push(req);
    let gone = false;
    const exit = (code: number) => {
      if (gone) return;
      gone = true;
      req.onExit(code);
    };
    const out = (obj: unknown) => req.onStdout(`${JSON.stringify(obj)}\n`);
    return {
      write: (data) => {
        c.lines.push(data);
        for (const line of data.split('\n').filter(Boolean)) answer(JSON.parse(line) as Record<string, unknown>, out, exit);
      },
      // A real kill gives the process two seconds to see stdin close first.
      kill: () => {
        c.kills++;
        if (opts.exitOnKill !== false) exit(137);
      },
    };
  };
  return c;
}

describe('ComputerDriverTransport keeps one driver running where it can', () => {
  it('starts it once and sends every request to it, with no exec per call', async () => {
    const c = spawningComputer((req, out) => out({ id: req['id'], ok: true, results: (req['steps'] as unknown[]).map(() => ({ served: true })) }));
    const t = new ComputerDriverTransport(c, 9222);
    await t.run({ steps: [{ op: 'send', method: 'A' }] });
    const res = await t.run({ steps: [{ op: 'send', method: 'A' }, { op: 'send', method: 'B' }] });
    expect(res.results).toEqual([{ served: true }, { served: true }]);
    expect(c.spawns).toHaveLength(1);
    expect(c.spawns[0]?.cmd).toEqual(['python3', DRIVER_SCRATCH_PATH, '--serve', '9222']);
    expect(c.calls).toHaveLength(0);
  });

  it('puts a reply split across chunks back together', async () => {
    const c = spawningComputer((req) => {
      const line = `${JSON.stringify({ id: req['id'], ok: true, results: [{ big: 'x'.repeat(5000) }] })}\n`;
      const spawned = c.spawns[0]!;
      for (let i = 0; i < line.length; i += 1000) spawned.onStdout(line.slice(i, i + 1000));
    });
    const res = await new ComputerDriverTransport(c, 9222).run({ steps: [{ op: 'send', method: 'A' }] });
    expect((res.results[0] as { big: string }).big).toHaveLength(5000);
  });

  it('falls back to one exec per request when the driver dies before it ever answers', async () => {
    const c = spawningComputer((_req, _out, exit) => exit(1));
    const t = new ComputerDriverTransport(c, 9222);
    expect((await t.run({ steps: [{ op: 'send', method: 'A' }] })).results).toEqual([{ oneShot: true }]);
    expect((await t.run({ steps: [{ op: 'send', method: 'A' }] })).results).toEqual([{ oneShot: true }]);
    expect(c.spawns).toHaveLength(1);
    expect(c.calls).toHaveLength(2);
    expect(await t.screencast('T1', 4)).toBe(false);
  });

  it('restarts a driver that dies after it has answered, failing only the call in flight', async () => {
    let n = 0;
    const c = spawningComputer((req, out, exit) => {
      n++;
      if (n === 2) exit(1);
      else out({ id: req['id'], ok: true, results: [{}] });
    });
    const t = new ComputerDriverTransport(c, 9222);
    await t.run({ steps: [{ op: 'send', method: 'A' }] });
    expect(await codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }] }))).toBe('E_COMPUTER_FAILED');
    await expect(t.run({ steps: [{ op: 'send', method: 'A' }] })).resolves.toMatchObject({ results: [{}] });
    expect(c.spawns).toHaveLength(2);
  });

  it('maps a served failure onto the same error a one-shot one gets', async () => {
    const c = spawningComputer((req, out) => out({ id: req['id'], ok: false, kind: 'bad_target', message: 'gone' }));
    expect(await codeOf(() => new ComputerDriverTransport(c, 9222).run({ steps: [] }))).toBe('E_TOOL_ERROR');
  });

  it('passes pushed frames to listeners, and stops casting on request', async () => {
    const seen: string[] = [];
    const c = spawningComputer((req, out) => {
      out({ id: req['id'], ok: true });
      if (req['op'] === 'screencast') out({ event: 'frame', targetId: 'T1', data: 'JPEG', width: 800, height: 600 });
      if (req['op'] === 'screencastStop') seen.push('stopped');
    });
    const t = new ComputerDriverTransport(c, 9222);
    t.onScreencast((e) => seen.push(e.type === 'frame' ? `${e.targetId}:${e.frame.data}:${e.frame.width}` : e.reason));
    expect(await t.screencast('T1', 4)).toBe(true);
    await t.stopScreencast('T1');
    expect(seen).toEqual(['T1:JPEG:800', 'stopped']);
  });

  it('never writes to a driver it killed, and starts a fresh one without giving up on serving', async () => {
    vi.useFakeTimers();
    try {
      // The first request wedges; the kill is pending; the next must not reuse it.
      const c = spawningComputer(
        (req, out) => {
          if (c.spawns.length > 1) out({ id: req['id'], ok: true, results: [{ fresh: true }] });
        },
        { exitOnKill: false },
      );
      const t = new ComputerDriverTransport(c, 9222);
      const wedged = codeOf(() => t.run({ steps: [{ op: 'send', method: 'A' }], timeoutMs: 1000 }));
      await vi.advanceTimersByTimeAsync(16_500);
      expect(await wedged).toBe('E_EXEC_TIMEOUT');
      const sent = c.lines.length;
      expect((await t.run({ steps: [{ op: 'send', method: 'A' }] })).results).toEqual([{ fresh: true }]);
      expect(c.spawns).toHaveLength(2);
      expect(c.lines).toHaveLength(sent + 1);
      expect(c.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records use while a long request runs, since no exec is there to do it', async () => {
    vi.useFakeTimers();
    try {
      let answer: (() => void) | undefined;
      const c = spawningComputer((req, out) => {
        answer = () => out({ id: req['id'], ok: true, results: [{}] });
      });
      const t = new ComputerDriverTransport(c, 9222);
      const long = t.run({ steps: [{ op: 'send', method: 'A' }], timeoutMs: 300_000 });
      await vi.advanceTimersByTimeAsync(150_000);
      expect(c.used).toBe(2);
      answer!();
      await long;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(c.used).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not kill the driver at once when a wait is longer than a timer can hold', async () => {
    vi.useFakeTimers();
    try {
      const c = spawningComputer(() => undefined);
      const t = new ComputerDriverTransport(c, 9222);
      void t.run({ steps: [{ op: 'send', method: 'A' }], timeoutMs: 3_000_000_000 }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      // Unclamped, Node fires a timer over 2^31-1 ms after 1 ms, killing a healthy driver.
      expect(c.kills).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says it cannot cast where the provider cannot hold a process open', async () => {
    expect(await new ComputerDriverTransport(okComputer([{}]), 9222).screencast('T1', 4)).toBe(false);
  });
});

describe('the driver’s questions to the host', () => {
  it('are answered straight back, mid-request, with the session’s answer or its refusal', async () => {
    const c = spawningComputer((req, out) => {
      if (req['op'] === 'hostReply') {
        if (req['call'] === 2) out({ id: 1, ok: true, results: [{ asked: true }] });
        return;
      }
      out({ event: 'host', call: 1, op: 'checkUrl', url: 'https://ok.test/' });
      out({ event: 'host', call: 2, op: 'checkUrl', url: 'file:///etc/passwd' });
    });
    const t = new ComputerDriverTransport(c, 9222);
    t.onHostCall((op, args) => {
      if (String(args['url']).startsWith('file:')) throw new HuskError('E_EXEC_DENIED', 'refusing the file: scheme');
      return `${op}:${String(args['url'])}`;
    });
    expect((await t.run({ steps: [{ op: 'action', do: 'script' }] })).results).toEqual([{ asked: true }]);
    const replies = c.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((m) => m['op'] === 'hostReply')
      // Matched by call id, so the order they go back in does not matter.
      .sort((a, b) => Number(a['call']) - Number(b['call']));
    expect(replies).toEqual([
      { op: 'hostReply', call: 1, value: 'checkUrl:https://ok.test/' },
      { op: 'hostReply', call: 2, error: 'refusing the file: scheme' },
    ]);
  });
});
