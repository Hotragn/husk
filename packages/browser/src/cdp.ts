import { HuskError } from '@husk-ai/core';
import type { Computer } from '@husk-ai/core';
import { DRIVER_PATH, DRIVER_SOURCE } from './driver.js';

/**
 * The Chrome DevTools Protocol, spoken from inside the computer.
 *
 * The earlier version of this file opened a websocket from the host to
 * Chromium's debug port. That cannot work and must not be made to work.
 * `--remote-debugging-port` binds loopback; WSL2's relay only forwards
 * `0.0.0.0` listeners and `docker -p` cannot publish a container-loopback
 * socket, so the host gets ECONNREFUSED. The fix is not to widen the bind
 * address -- an unauthenticated CDP port is a remote-code-execution primitive,
 * and anything that can reach it owns the browser. The fix is to move the
 * driver to where the browser already is.
 *
 * So the transport is `Computer.exec` running `driver.py`, and the wire format
 * is one JSON object in, one JSON object out. A driver process is stateless:
 * it connects, runs a short list of steps, prints, and exits. Chromium persists
 * between invocations, so the *page* keeps its state even though the driver
 * keeps none.
 *
 * A round trip costs a Python start plus a websocket handshake, measured at
 * roughly 90ms on a warm arm64 WSL2. That is why the unit of work is a list of
 * steps rather than a single command: a click is four CDP calls and pays for
 * one invocation, not four. If the cost ever stops being acceptable, more
 * batching is the lever -- not a socket to the host.
 */

export type CdpParams = Record<string, unknown>;

/**
 * Skip a step when an earlier one already said the rest is pointless.
 *
 * Waiting thirty seconds for a load event after a navigation Chromium refused
 * is the case this exists for: without it, "one invocation per method" would
 * mean paying the full timeout to learn something already known at step zero.
 */
export interface SkipIf {
  /** Index into the step list, as the driver sees it. */
  step: number;
  /** Skip when that step's result has a truthy value under this key. */
  key: string;
}

/** Issue one CDP command. `session: true` routes it to the attached page. */
export interface SendStep {
  op: 'send';
  method: string;
  params?: CdpParams;
  session?: boolean;
  timeoutMs?: number;
  /** Record a Chromium rejection as `{ error }` instead of failing the batch. A dead browser stays fatal. */
  soft?: boolean;
  skipIf?: SkipIf;
  /** The inverse: run only if an earlier step set this key truthy. */
  skipUnless?: SkipIf;
}

/**
 * Block until a protocol event arrives.
 *
 * Events only exist for the life of one driver invocation, which is exactly why
 * "navigate, then wait for load" has to be a single request. There is no race:
 * the driver reads nothing until it has sent the navigate, so an event Chromium
 * emits in between is sitting in the socket buffer waiting to be read.
 */
export interface WaitStep {
  op: 'wait';
  event: string;
  session?: boolean;
  timeoutMs?: number;
  /** A timeout yields `{ fired: false }` instead of failing the request. */
  optional?: boolean;
  skipIf?: SkipIf;
  /** The inverse: run only if an earlier step set this key truthy. */
  skipUnless?: SkipIf;
}

export type DriverStep = SendStep | WaitStep;

export interface WaitResult {
  fired: boolean;
  params?: CdpParams;
}

export interface DriverRequest {
  steps: DriverStep[];
  /** Attach to this page first. Target ids survive reconnects; session ids do not. */
  targetId?: string;
  timeoutMs?: number;
}

export interface DriverResult {
  results: unknown[];
  browser?: string;
  sessionId?: string;
  ws?: string;
}

/** Everything this client needs from the computer, so tests need no computer. */
export interface CdpTransport {
  run(req: DriverRequest): Promise<DriverResult>;
  close(): Promise<void>;
}

export interface CdpOptions {
  /** Default ceiling for one driver invocation. Defaults to 60s. */
  timeoutMs?: number;
}

type MappedCode = 'E_COMPUTER_FAILED' | 'E_EXEC_TIMEOUT' | 'E_TOOL_ERROR' | 'E_EXEC_FAILED' | 'E_INTERNAL';

/**
 * The failure kinds `driver.py` reports, and what husk calls each of them.
 *
 * These are the distinctions that change what you do next: the browser is not
 * there, the browser died holding your command, the page never answered,
 * Chromium refused the command, or husk has a bug. Collapsing any two of them
 * costs a debugging session.
 */
const KIND_TO_ERROR: Record<string, { code: MappedCode; hint: string }> = {
  unreachable: {
    code: 'E_COMPUTER_FAILED',
    hint: 'Chromium is not listening on its debug port inside the computer -- it crashed or never started; the session relaunches it on the next call',
  },
  browser_gone: {
    code: 'E_COMPUTER_FAILED',
    hint: 'Chromium exited while the command was in flight -- the chromium log in the browser cache directory says why',
  },
  timeout: {
    code: 'E_EXEC_TIMEOUT',
    hint: 'the page is probably blocked on something -- a dialog, or a script that never yields',
  },
  protocol: {
    code: 'E_TOOL_ERROR',
    hint: 'the browser rejected the command -- usually a stale element reference or a closed page',
  },
  bad_target: {
    code: 'E_TOOL_ERROR',
    hint: 'the page this session was driving is gone -- take a fresh snapshot, or open a new page',
  },
  internal: {
    code: 'E_INTERNAL',
    hint: 'this is a husk bug in the browser driver; the traceback is in details',
  },
};

/**
 * A connection in the only sense that survives here: a transport, plus the
 * knowledge of how to reach a page. Nothing is held open.
 */
export class CdpConnection {
  private closedReason: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: CdpTransport,
    opts: CdpOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** Run a batch of steps, optionally attached to a page. Returns one result per step. */
  async run(steps: DriverStep[], opts: { targetId?: string; timeoutMs?: number } = {}): Promise<unknown[]> {
    this.assertOpen(describe(steps));

    const res = await this.transport.run({
      steps,
      ...(opts.targetId !== undefined ? { targetId: opts.targetId } : {}),
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
    });

    if (res.results.length !== steps.length) {
      throw new HuskError('E_INTERNAL', 'the browser driver returned the wrong number of results', {
        hint: 'this is a husk bug; the counts are in details',
        details: { expected: steps.length, got: res.results.length },
      });
    }
    return res.results;
  }

  /** One command, for the cases that genuinely are one command. */
  async send(method: string, params: CdpParams = {}, opts: { targetId?: string; timeoutMs?: number } = {}): Promise<CdpParams> {
    const step: SendStep = { op: 'send', method, params, session: opts.targetId !== undefined };
    const [only] = await this.run([step], opts);
    return (only ?? {}) as CdpParams;
  }

  private assertOpen(what: string): void {
    if (this.closedReason === undefined) return;
    throw new HuskError('E_EXEC_FAILED', `cannot call ${what}: ${this.closedReason}`, {
      hint: 'the browser session is gone -- open a new page and retry',
    });
  }

  async close(reason = 'the connection was closed'): Promise<void> {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    await this.transport.close().catch(() => undefined);
  }
}

function describe(steps: DriverStep[]): string {
  const first = steps[0];
  if (!first) return 'a browser command';
  return first.op === 'send' ? first.method : `a wait for ${first.event}`;
}

/**
 * Where the driver prefers to live: a tmpfs inside the computer.
 *
 * This is a measured decision, not a preference. On the `local` provider on
 * Windows, `/work` is a Windows directory reached through WSL's drvfs, and
 * making CPython read an 18 KB script from there costs about 700ms *per
 * invocation*: 784ms from `/work` against 78ms from ext4, same request, same
 * browser. The driver is disposable -- unlike the 150 MB Chromium next to it --
 * so it has no business being on the persistent volume.
 *
 * `/dev/shm` is tmpfs on every Linux that matters and exists in Docker, Podman
 * and WSL. When it is not writable, `DRIVER_PATH` is the fallback and the only
 * cost is latency.
 */
export const DRIVER_SCRATCH_PATH = '/dev/shm/husk-browser-driver.py';

export interface ComputerTransportOptions {
  /** Force the driver's location, skipping the scratch-path probe. */
  driverPath?: string;
  /**
   * Cap on the driver's stdout.
   *
   * The provider's default is 256 KiB and it elides the middle of anything
   * larger, which would turn a full-page screenshot into valid-looking JSON
   * with a hole in it. Screenshots and accessibility trees are routinely
   * megabytes, so the cap has to sit well clear of them.
   */
  maxOutputBytes?: number;
}

/** Turn a driver invocation into a `Computer.exec`, and its JSON into results or a `HuskError`. */
export class ComputerDriverTransport implements CdpTransport {
  private readonly pinnedPath: string | undefined;
  private readonly maxOutputBytes: number;
  /** Resolves to the path the driver actually landed on. */
  private installed: Promise<string> | undefined;
  /** Cached so the common call skips a /json/version round trip. The driver rediscovers if it is stale. */
  private ws: string | undefined;

  constructor(
    private readonly computer: Computer,
    private readonly port: number,
    opts: ComputerTransportOptions = {},
  ) {
    this.pinnedPath = opts.driverPath;
    this.maxOutputBytes = opts.maxOutputBytes ?? 96 * 1024 * 1024;
  }

  async run(req: DriverRequest): Promise<DriverResult> {
    const path = await this.install();
    try {
      return await this.invoke(req, path);
    } catch (err) {
      // A wiped profile directory takes the driver with it, and a missing
      // script looks nothing like a browser failure. Reinstall once, then give
      // up -- a second miss is a real problem with the filesystem.
      if (!(err instanceof HuskError) || err.details?.['missingDriver'] !== true) throw err;
      this.installed = undefined;
      return await this.invoke(req, await this.install());
    }
  }

  private async invoke(req: DriverRequest, driverPath: string): Promise<DriverResult> {
    const timeoutMs = req.timeoutMs ?? 60_000;
    const body = JSON.stringify({
      port: this.port,
      ...(this.ws ? { ws: this.ws } : {}),
      ...req,
      timeoutMs,
    });

    const res = await this.computer
      .exec({
        cmd: ['python3', driverPath],
        stdin: body,
        // The driver enforces its own deadline and reports a structured
        // timeout. This one is the backstop for a driver that wedged, so it has
        // to be the looser of the two or it would mask the useful error.
        timeoutSec: Math.ceil(timeoutMs / 1000) + 15,
        maxOutputBytes: this.maxOutputBytes,
      })
      .catch((err: unknown) => {
        if (err instanceof HuskError) throw err;
        throw new HuskError('E_COMPUTER_FAILED', 'could not run the browser driver in the computer', {
          hint: 'the computer refused or failed the exec -- check it is still running',
          cause: err,
        });
      });

    if (res.timedOut) {
      throw new HuskError('E_EXEC_TIMEOUT', `the browser driver did not finish within ${timeoutMs}ms`, {
        hint: 'the page is probably blocked on something -- a dialog, or a script that never yields',
        details: { stderr: res.stderr.slice(-1000) },
      });
    }

    if (res.exitCode !== 0) {
      const missing = /No such file or directory|can't open file/i.test(res.stderr);
      throw new HuskError('E_EXEC_FAILED', 'the browser driver could not run', {
        hint: missing
          ? 'the driver script is not in the computer; husk reinstalls it and retries once'
          : 'python3 must exist inside the computer -- it is in every husk flavour, so the stderr in details is the real answer',
        details: {
          exitCode: res.exitCode,
          stderr: res.stderr.slice(-2000),
          ...(missing ? { missingDriver: true } : {}),
        },
      });
    }

    if (res.truncated) {
      throw new HuskError('E_EXEC_FAILED', 'the browser driver produced more output than husk would read', {
        hint: 'raise maxOutputBytes on the transport, or ask for a viewport screenshot rather than a full-page one',
        details: { maxOutputBytes: this.maxOutputBytes },
      });
    }

    let parsed: {
      ok?: unknown;
      results?: unknown;
      kind?: unknown;
      message?: unknown;
      details?: unknown;
      ws?: unknown;
      browser?: unknown;
      sessionId?: unknown;
    };
    try {
      parsed = JSON.parse(res.stdout.trim()) as typeof parsed;
    } catch {
      throw new HuskError('E_EXEC_FAILED', 'the browser driver printed something that was not JSON', {
        hint: 'something else in the computer is writing to stdout -- a shell rc file is the usual culprit',
        details: { stdout: res.stdout.slice(0, 2000), stderr: res.stderr.slice(-1000) },
      });
    }

    if (parsed.ok !== true) {
      const kind = typeof parsed.kind === 'string' ? parsed.kind : 'internal';
      const mapped = KIND_TO_ERROR[kind] ?? KIND_TO_ERROR['internal']!;
      const message = typeof parsed.message === 'string' ? parsed.message : 'the browser driver failed';
      const details = (parsed.details ?? {}) as Record<string, unknown>;
      throw new HuskError(mapped.code, message, { hint: mapped.hint, details: { kind, ...details } });
    }

    if (typeof parsed.ws === 'string') this.ws = parsed.ws;

    return {
      results: Array.isArray(parsed.results) ? parsed.results : [],
      ...(typeof parsed.browser === 'string' ? { browser: parsed.browser } : {}),
      ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
      ...(typeof parsed.ws === 'string' ? { ws: parsed.ws } : {}),
    };
  }

  /** Write the driver into the computer, once per transport, preferring tmpfs. */
  private install(): Promise<string> {
    this.installed ??= this.installOnce().catch((err: unknown) => {
      this.installed = undefined;
      throw err;
    });
    return this.installed;
  }

  private async installOnce(): Promise<string> {
    if (this.pinnedPath) {
      await this.writeTo(this.pinnedPath);
      return this.pinnedPath;
    }

    // `cat >` rather than `writeFile`, because the fast path is outside the
    // guarded working directory and the file-writing surface is jailed to it,
    // correctly. This is husk's own scratch, not the agent's data.
    const wrote = await this.computer
      .exec({
        cmd: `cat > ${DRIVER_SCRATCH_PATH} && chmod 0644 ${DRIVER_SCRATCH_PATH}`,
        stdin: DRIVER_SOURCE,
        timeoutSec: 30,
      })
      .catch(() => undefined);
    if (wrote?.exitCode === 0) return DRIVER_SCRATCH_PATH;

    await this.writeTo(DRIVER_PATH);
    return DRIVER_PATH;
  }

  private async writeTo(path: string): Promise<void> {
    await this.computer.writeFile(path, DRIVER_SOURCE, { mode: '0755', mkdirp: true }).catch((err: unknown) => {
      throw new HuskError('E_COMPUTER_FAILED', 'could not install the browser driver in the computer', {
        hint: `husk writes ${path} on first use -- check that path is writable`,
        cause: err,
      });
    });
  }

  async close(): Promise<void> {
    // Nothing is held open: that is the entire point of the design.
    this.ws = undefined;
  }
}

export async function createTarget(conn: CdpConnection, url = 'about:blank'): Promise<string> {
  const res = await conn.send('Target.createTarget', { url });
  const targetId = res['targetId'];
  if (typeof targetId !== 'string') {
    throw new HuskError('E_EXEC_FAILED', 'Chromium did not return a target id', {
      hint: 'this is a husk bug; the raw result is in details',
      details: { result: res },
    });
  }
  return targetId;
}

/** Narrow a `wait` step's result without trusting the driver's shape. */
export function waitResultOf(value: unknown): WaitResult {
  const v = (value ?? {}) as { fired?: unknown; params?: unknown };
  return {
    fired: v.fired === true,
    ...(v.params && typeof v.params === 'object' ? { params: v.params as CdpParams } : {}),
  };
}
