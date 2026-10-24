import { HuskError } from '@husk-ai/core';
import type { Computer, ComputerProcess } from '@husk-ai/core';
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
 * So the transport is `driver.py` inside the computer. Where the provider can
 * keep a process's stdin open (`Computer.spawn`), one driver lives as long as
 * the browser session and answers newline-delimited requests over one
 * websocket, which also lets it push the live screen. Where it cannot, each
 * request is one `Computer.exec`: connect, run the steps, print, exit, at the
 * cost of a Python start plus a websocket handshake -- roughly 90-150ms.
 *
 * Either way the unit of work is a list of steps rather than a single command:
 * a click is four CDP calls and pays for one round, not four.
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

/**
 * A whole page action, done by the driver in one go: `ACTIONS` in driver.py,
 * built by `Page.actions`. A failed one records `{ error }` and every later
 * step comes back `{ skipped: true }`.
 */
export interface ActionStep {
  op: 'action';
  do: string;
  session?: boolean;
  timeoutMs?: number;
  skipIf?: SkipIf;
  skipUnless?: SkipIf;
  [field: string]: unknown;
}

export type DriverStep = SendStep | WaitStep | ActionStep;

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

/** One frame of a tab, for a person watching: a JPEG and its size in CSS pixels. */
export interface ScreenFrame {
  data: string;
  width: number;
  height: number;
}

/** A pushed frame, or a screencast that stopped. No `targetId` on an end means every one did. */
export type ScreencastEvent =
  | { type: 'frame'; targetId: string; frame: ScreenFrame }
  | { type: 'ended'; targetId?: string; reason: string };

/** Everything this client needs from the computer, so tests need no computer. */
export interface CdpTransport {
  run(req: DriverRequest): Promise<DriverResult>;
  close(): Promise<void>;
  /**
   * Push frames of this tab at up to `fps`, or say `false` when this transport
   * cannot -- the caller then asks for frames itself. Calling it again for the
   * same tab changes the rate.
   */
  screencast?(targetId: string, fps: number): Promise<boolean>;
  stopScreencast?(targetId: string): Promise<void>;
  onScreencast?(fn: (e: ScreencastEvent) => void): () => void;
  /**
   * Answer the driver's questions mid-request -- may a script visit this URL,
   * what does this tree compact to. A throw becomes the script's PageError.
   */
  onHostCall?(fn: HostCall): void;
  /** Whether a request is waiting or running. */
  busy?(): boolean;
}

/** One question from the driver, answered on the host. */
export type HostCall = (op: string, args: Record<string, unknown>) => unknown;

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
  action: {
    code: 'E_TOOL_ERROR',
    hint: 'the page did not have what the action needed -- take a fresh snapshot and try again',
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
  if (first.op === 'action') return `the ${first.do} action`;
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

/**
 * The driver inside the computer: one long-lived process where the provider can
 * hold its stdin open, one exec per request where it cannot. Its JSON becomes
 * results or a `HuskError` the same way in both.
 */
export class ComputerDriverTransport implements CdpTransport {
  private readonly pinnedPath: string | undefined;
  private readonly maxOutputBytes: number;
  /** Resolves to the path the driver actually landed on. */
  private installed: Promise<string> | undefined;
  /** Cached so the common call skips a /json/version round trip. The driver rediscovers if it is stale. */
  private ws: string | undefined;
  /** The long-lived driver, while one is running. */
  private server: DriverServer | undefined;
  /** Set once a long-lived driver died without answering: from then on, one exec per request. */
  private oneShot = false;
  /** The driver answers one request at a time, so they go out one at a time and each timeout is its own. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly castListeners = new Set<(e: ScreencastEvent) => void>();
  private inFlight = 0;
  private hostCall: HostCall | undefined;

  constructor(
    private readonly computer: Computer,
    private readonly port: number,
    opts: ComputerTransportOptions = {},
  ) {
    this.pinnedPath = opts.driverPath;
    this.maxOutputBytes = opts.maxOutputBytes ?? 96 * 1024 * 1024;
  }

  async run(req: DriverRequest): Promise<DriverResult> {
    const timeoutMs = req.timeoutMs ?? 60_000;
    this.inFlight++;
    try {
      const served = await this.serve({ steps: req.steps, ...(req.targetId !== undefined ? { targetId: req.targetId } : {}) }, timeoutMs);
      return served ? resultOf(served) : await this.runOneShot(req);
    } finally {
      this.inFlight--;
    }
  }

  /** Whether a request is waiting or running, so the browser is not closed for idleness under it. */
  busy(): boolean {
    return this.inFlight > 0;
  }

  async screencast(targetId: string, fps: number): Promise<boolean> {
    const served = await this.serve({ op: 'screencast', targetId, fps, quality: 60 }, 15_000);
    if (!served) return false;
    resultOf(served);
    return true;
  }

  async stopScreencast(targetId: string): Promise<void> {
    if (!this.server) return;
    await this.serve({ op: 'screencastStop', targetId }, 15_000).catch(() => undefined);
  }

  onHostCall(fn: HostCall): void {
    this.hostCall = fn;
  }

  /**
   * Kill this browser's driver and every script process, from inside the
   * computer: by the driver's own command line, and by the tag each script
   * carries in its environment. An exec, so it counts as use; it runs only
   * after a wedge.
   */
  private async reap(): Promise<void> {
    await this.computer.exec({ cmd: ['python3', '-c', REAP_SOURCE, String(this.port)], timeoutSec: 15 }).catch(() => undefined);
  }

  onScreencast(fn: (e: ScreencastEvent) => void): () => void {
    this.castListeners.add(fn);
    return () => this.castListeners.delete(fn);
  }

  /**
   * One request to the long-lived driver, or `undefined` when there is not
   * going to be one here and the caller should exec instead.
   */
  private serve(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    const next = this.queue.then(async () => {
      if (!this.computer.spawn || this.oneShot) return undefined;
      let server = this.server;
      if (!server || server.exited) {
        const path = await this.install();
        try {
          server = new DriverServer(this.computer, path, this.port, (e) => this.emit(e), (op, args) => {
            if (!this.hostCall) throw new Error('this browser answers no questions from scripts');
            return this.hostCall(op, args);
          });
        } catch {
          // The provider refused to start it at all; an exec says why, if it is real.
          this.oneShot = true;
          return undefined;
        }
        this.server = server;
      }
      // An exec records use while it runs, and a served request runs no exec.
      // So a request still going after a while -- a long browser_run, a long
      // wait -- records it too, or the idle reaper takes the computer out from
      // under it. Frames finish in well under the interval and never do.
      const beat = setInterval(() => this.computer.markUsed?.(), HEARTBEAT_MS);
      beat.unref?.();
      // Only a script asks the host anything, so only its request opens the window.
      const steps = Array.isArray(body['steps']) ? (body['steps'] as Array<Record<string, unknown>>) : [];
      const hostCalls = steps.some((s) => s['op'] === 'action' && s['do'] === 'script');
      try {
        return await server.request(body, timeoutMs, { hostCalls });
      } catch (err) {
        // The backstop fired: the driver wedged, or something in the computer
        // stopped it. Killing the exec does not reach a stopped process inside,
        // so end it, and any script it ran, from inside too.
        if (server.killed && err instanceof HuskError && err.code === 'E_EXEC_TIMEOUT') void this.reap();
        // Died by itself before it ever answered: whatever the reason -- no
        // python3, a provider that closes stdin -- one exec per request still
        // works. One husk killed proves nothing about the provider.
        if (server.exited && !server.answered && !server.killed) {
          this.oneShot = true;
          if (err instanceof HuskError && err.details?.['missingDriver'] === true) this.installed = undefined;
          return undefined;
        }
        throw err;
      } finally {
        clearInterval(beat);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private emit(e: ScreencastEvent): void {
    for (const fn of this.castListeners) {
      try {
        fn(e);
      } catch {
        // A listener that throws is the listener's problem, not the driver's.
      }
    }
  }

  private async runOneShot(req: DriverRequest): Promise<DriverResult> {
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
        timeoutSec: Math.min(Math.ceil(timeoutMs / 1000) + 15, Math.floor(MAX_TIMER_MS / 1000)),
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

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    } catch {
      throw new HuskError('E_EXEC_FAILED', 'the browser driver printed something that was not JSON', {
        hint: 'something else in the computer is writing to stdout -- a shell rc file is the usual culprit',
        details: { stdout: res.stdout.slice(0, 2000), stderr: res.stderr.slice(-1000) },
      });
    }

    const out = resultOf(parsed);
    if (out.ws) this.ws = out.ws;
    return out;
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
    this.ws = undefined;
    this.server?.kill();
    this.server = undefined;
  }
}

/** A driver's answer as results, or its failure as the `HuskError` its kind maps to. */
function resultOf(parsed: Record<string, unknown>): DriverResult {
  if (parsed['ok'] !== true) {
    const kind = typeof parsed['kind'] === 'string' ? parsed['kind'] : 'internal';
    const mapped = KIND_TO_ERROR[kind] ?? KIND_TO_ERROR['internal']!;
    const message = typeof parsed['message'] === 'string' ? parsed['message'] : 'the browser driver failed';
    const details = (parsed['details'] ?? {}) as Record<string, unknown>;
    throw new HuskError(mapped.code, message, { hint: mapped.hint, details: { kind, ...details } });
  }
  return {
    results: Array.isArray(parsed['results']) ? parsed['results'] : [],
    ...(typeof parsed['browser'] === 'string' ? { browser: parsed['browser'] } : {}),
    ...(typeof parsed['sessionId'] === 'string' ? { sessionId: parsed['sessionId'] } : {}),
    ...(typeof parsed['ws'] === 'string' ? { ws: parsed['ws'] } : {}),
  };
}

/**
 * `driver.py --serve` in the computer: requests out on stdin, answers and
 * pushed frames back on stdout, one JSON object per line.
 *
 * Lines are joined at chunk boundaries rather than found by searching a
 * growing buffer, because a full-page screenshot is one line of many
 * megabytes and rescanning it on every chunk is quadratic.
 */
/** The longest delay Node's `setTimeout` honours; anything longer fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** The longest line read from the driver. A full-page screenshot, base64, is far less. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;

/** The longest URL a script may ask the host to check. */
const MAX_HOST_URL = 8192;

/**
 * Run inside the computer by `reap`: SIGKILL the served driver on this port,
 * and every process carrying a script's HUSK_SCRIPT tag. Its own command line
 * has no element ending in driver.py, and its environment no tag.
 */
const REAP_SOURCE = [
  'import glob, os, signal, sys',
  'port = sys.argv[1].encode()',
  "for d in glob.glob('/proc/[0-9]*'):",
  '    try:',
  "        argv = open(d + '/cmdline', 'rb').read().split(b'\\0')",
  "        env = open(d + '/environ', 'rb').read().split(b'\\0')",
  '    except OSError:',
  '        continue',
  "    served = any(a.endswith(b'driver.py') and argv[i + 1:i + 3] == [b'--serve', port] for i, a in enumerate(argv))",
  "    if served or any(e.startswith(b'HUSK_SCRIPT=') for e in env):",
  '        try:',
  "            os.kill(int(d.rsplit('/', 1)[1]), signal.SIGKILL)",
  '        except OSError:',
  '            pass',
].join('\n');

/** How often a long-running served request records use. Well inside any idle timeout worth setting. */
const HEARTBEAT_MS = 60_000;

class DriverServer {
  answered = false;
  exited = false;
  /** Husk stopped it, after a timeout or a close. Not a sign the provider cannot run one. */
  killed = false;
  private readonly proc: ComputerProcess;
  private parts: string[] = [];
  private stderr = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();

  constructor(
    computer: Computer,
    path: string,
    port: number,
    private readonly onEvent: (e: ScreencastEvent) => void,
    private readonly onHost: HostCall = () => {
      throw new Error('no host calls here');
    },
  ) {
    this.proc = computer.spawn!({
      cmd: ['python3', path, '--serve', String(port)],
      onStdout: (chunk) => this.read(chunk),
      onStderr: (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-4000);
      },
      onExit: (code) => this.exit(code),
    });
  }

  request(body: Record<string, unknown>, timeoutMs: number, opts: { hostCalls?: boolean } = {}): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(this.gone(1));
    const id = this.nextId++;
    if (opts.hostCalls) this.hostWindow = id;
    const settled = (): void => {
      if (this.hostWindow === id) this.hostWindow = undefined;
    };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // The driver keeps its own deadline and reports a structured timeout.
      // This is the backstop for a driver that wedged, so it is the looser.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(
          new HuskError('E_EXEC_TIMEOUT', `the browser driver did not answer within ${timeoutMs}ms`, {
            hint: 'the page is probably blocked on something -- a dialog, or a script that never yields; husk restarts the driver',
          }),
        );
        // Clamped: past 2^31-1 ms Node fires a timer at once, which would kill
        // a healthy driver the moment a long wait went out.
      }, Math.min(timeoutMs + 15_000, MAX_TIMER_MS));
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          this.answered = true;
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.write(`${JSON.stringify({ ...body, id, timeoutMs })}\n`);
    }).finally(settled);
  }

  /**
   * Stop it, and stop using it now. The process gets a moment to see its stdin
   * close before the signal, and must not be written to in that moment, so it
   * counts as gone from here: the next request starts a fresh one.
   */
  kill(): void {
    this.killed = true;
    this.exit(137);
    this.proc.kill();
  }

  /**
   * Bounded, because anything in the computer can write to this pipe: a line
   * that never ends would otherwise grow until the shared Husk runs out of
   * memory and takes every computer with it. A screenshot is the biggest
   * honest line, well under the cap; past it, the driver is killed and the
   * next call starts a fresh one.
   */
  private read(chunk: string): void {
    if (this.exited) return;
    let start = 0;
    for (let i = chunk.indexOf('\n'); i >= 0; i = chunk.indexOf('\n', start)) {
      if (this.partsLength + (i - start) > MAX_LINE_CHARS) return this.overflow();
      this.parts.push(chunk.slice(start, i));
      start = i + 1;
      const line = this.parts.join('');
      this.parts = [];
      this.partsLength = 0;
      this.line(line);
    }
    if (start < chunk.length) {
      this.partsLength += chunk.length - start;
      if (this.partsLength > MAX_LINE_CHARS) return this.overflow();
      this.parts.push(chunk.slice(start));
    }
  }

  private overflow(): void {
    this.parts = [];
    this.partsLength = 0;
    this.kill();
  }

  /** Host questions dropped unanswered: outside a script request, or while one was being answered. */
  droppedHostCalls = 0;
  /** The id of the script request in flight, the only time host questions are answered. */
  private hostWindow: number | undefined;
  private answering = false;
  private partsLength = 0;

  private line(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // not the driver's: something in the computer wrote to stdout
    }
    if (typeof msg['id'] === 'number') {
      const waiting = this.pending.get(msg['id']);
      this.pending.delete(msg['id']);
      waiting?.resolve(msg);
      return;
    }
    const targetId = typeof msg['targetId'] === 'string' ? msg['targetId'] : undefined;
    if (msg['event'] === 'frame' && targetId && typeof msg['data'] === 'string') {
      this.onEvent({
        type: 'frame',
        targetId,
        frame: { data: msg['data'], width: Number(msg['width']) || 0, height: Number(msg['height']) || 0 },
      });
    } else if (msg['event'] === 'host') {
      void this.answer(msg);
    } else if (msg['event'] === 'castEnded') {
      this.onEvent({ type: 'ended', ...(targetId ? { targetId } : {}), reason: String(msg['reason'] ?? 'it stopped') });
    }
  }

  /**
   * Answer a question the driver asked mid-request. Written straight to the
   * process, not queued: the request it belongs to is the one in flight.
   *
   * The questions come from inside the computer, so they are treated as
   * hostile: answered only while a script request is in flight and one at a
   * time -- the driver never has two -- with every other line dropped and
   * counted; a URL is checked only up to MAX_HOST_URL characters; and no
   * error repeats its input back. Replies are small, so writing them cannot
   * pile up behind a process that does not read.
   */
  private async answer(msg: Record<string, unknown>): Promise<void> {
    if (this.hostWindow === undefined || this.answering) {
      this.droppedHostCalls++;
      return;
    }
    const window = this.hostWindow;
    this.answering = true;
    const { event: _event, call, op, ...args } = msg;
    let reply: Record<string, unknown>;
    try {
      if (op === 'checkUrl' && (typeof args['url'] !== 'string' || args['url'].length > MAX_HOST_URL)) {
        throw new Error(`that URL is not a string of at most ${MAX_HOST_URL} characters`);
      }
      reply = { op: 'hostReply', call, value: (await this.onHost(String(op), args)) ?? null };
    } catch (err) {
      const e = err as HuskError;
      reply = { op: 'hostReply', call, error: `${e.message}${e.hint ? ` (${e.hint})` : ''}`.slice(0, 500) };
    } finally {
      this.answering = false;
    }
    if (!this.exited && this.hostWindow === window) this.proc.write(`${JSON.stringify(reply)}\n`);
  }

  private gone(code: number): HuskError {
    const missing = /No such file or directory|can't open file/i.test(this.stderr);
    return new HuskError('E_COMPUTER_FAILED', 'the browser driver exited', {
      hint: missing
        ? 'the driver script is not in the computer; husk reinstalls it'
        : 'husk starts it again on the next call; the stderr in details says why it went',
      details: { exitCode: code, stderr: this.stderr.slice(-2000), ...(missing ? { missingDriver: true } : {}) },
    });
  }

  private exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    const err = this.gone(code);
    for (const waiting of this.pending.values()) waiting.reject(err);
    this.pending.clear();
    this.onEvent({ type: 'ended', reason: 'the browser driver exited' });
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
