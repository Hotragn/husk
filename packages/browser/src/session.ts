import { HuskError, assertUrlAllowed, onComputerDestroyed, ownsLoopback } from '@husk/core';
import type { Computer, NetworkPolicy } from '@husk/core';
import { CdpConnection, ComputerDriverTransport, createTarget } from './cdp.js';
import type { CdpTransport } from './cdp.js';
import { Page } from './page.js';
import { CACHE_ROOT, provisionChromium } from './provision.js';
import type { ProvisionResult } from './provision.js';

/**
 * One browser per computer, launched on first use and closed when it goes idle.
 *
 * A resident Chromium is a few hundred megabytes of RSS. A developer with four
 * husks open would be handing the OOM killer its shortlist, so the browser is
 * not a thing you start -- it is a thing that exists while you are using it.
 * The user-data-dir outlives it, so a login survives the relaunch and the agent
 * does not have to sign in again every five minutes.
 *
 * The debug port is bound to the computer's own loopback and husk never
 * publishes it: nothing here calls `exposePort`, and `--remote-debugging-address`
 * appears in no file. An unauthenticated CDP port is a remote-code-execution
 * primitive, and the only reason the old design wanted it reachable was that the
 * driver sat on the wrong side of the boundary. The driver now runs inside the
 * computer, so the port has no reason to leave.
 *
 * That is a statement about what husk does, not a containment guarantee. On
 * `local` under WSL2 the platform forwards loopback listeners to Windows by
 * itself -- measured: a `--bind 127.0.0.1` listener started with no involvement
 * from husk answers on the Windows side -- so on that provider any local process
 * can reach this port. `warnIfDebugPortIsExposed` says so out loud at launch
 * rather than leaving the stronger claim standing. The providers that own their
 * network namespace do contain it; that is the difference the warning names.
 */


export interface SessionOptions {
  /** Close the browser after this long with no calls. 0 disables. Defaults to 5 min. */
  idleTimeoutMs?: number;
  onProgress?: (message: string) => void;
  /** Override the policy the computer declares. */
  network?: NetworkPolicy;
  viewport?: { width: number; height: number };
  /**
   * Swap the transport out.
   *
   * The point of an injectable transport is that everything above it is
   * testable with no Chromium, no Python and no computer -- which is what keeps
   * the unit suite runnable anywhere.
   */
  transport?: (computer: Computer, port: number) => CdpTransport;
}

const DEFAULT_IDLE_MS = 5 * 60_000;
const PROFILE_DIR = `${CACHE_ROOT}/profile`;
const LOG_PATH = `${CACHE_ROOT}/chromium.log`;

/**
 * Say plainly when the debug port is reachable by things other than the driver.
 *
 * Husk binds it to the computer's loopback and publishes nothing, but on a
 * provider that shares a network stack with the host that is not the same as
 * containing it -- WSL2 forwards loopback listeners to Windows on its own. CDP
 * has no authentication, so anything that can reach the port can drive the
 * browser, read what it can read, and run script in its pages.
 *
 * Once per session, not per call: a warning printed forty times is one nobody
 * reads.
 */
let warnedComputers: Set<string> | undefined;

export function warnIfDebugPortIsExposed(
  computer: Computer,
  port: number,
  say: (message: string) => void,
): void {
  if (ownsLoopback(computer.info.provider)) return;
  warnedComputers ??= new Set();
  if (warnedComputers.has(computer.id)) return;
  warnedComputers.add(computer.id);
  say(
    `warning: this provider (${computer.info.provider}) shares a network stack with the host, ` +
      `so Chromium's debug port (127.0.0.1:${port}) may be reachable by other local processes. ` +
      `CDP has no authentication. Use docker, podman or fly for browsing you do not trust.`,
  );
}

export class BrowserSession {
  private conn: CdpConnection | undefined;
  private page: Page | undefined;
  private launching: Promise<Page> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private chromium: ProvisionResult | undefined;
  private port = 0;
  private readonly progressListeners = new Set<(message: string) => void>();

  constructor(
    readonly computer: Computer,
    private readonly opts: SessionOptions = {},
  ) {}

  private get idleMs(): number {
    return this.opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      void this.close('idle');
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** The live page, launching Chromium if this is the first call. */
  async activePage(): Promise<Page> {
    this.touch();
    if (this.page && this.conn && !this.conn.closed) return this.page;
    this.launching ??= this.launch().finally(() => {
      this.launching = undefined;
    });
    return await this.launching;
  }

  /**
   * Navigate, after the policy check.
   *
   * This is the only door into the browser that takes a URL from a caller, so
   * it is the only place the check has to happen -- and it happens against the
   * parsed URL that is then handed on, so there is no window in which the
   * checked string and the fetched string could differ.
   */
  async goto(url: string, opts: { timeoutMs?: number } = {}): Promise<{ url: string; loaded: boolean }> {
    const policy = this.opts.network ?? this.computer.info.spec.network;
    const parsed = assertUrlAllowed(url, policy, {
      loopbackIsOwn: ownsLoopback(this.computer.info.provider),
    });
    const page = await this.activePage();
    return await page.goto(parsed.toString(), opts);
  }

  /**
   * Watch this session's progress messages.
   *
   * `browserFor` caches by computer id and ignores the options on every call
   * after the first, so a listener passed as an option only ever reaches the
   * caller that happened to create the session. The server creates sessions
   * from an HTTP handler and wants the messages on its event bus, so the
   * listener has to be attachable after the fact. Returns an unsubscribe.
   */
  onProgress(fn: (message: string) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  /** Fan a progress message out to the constructor option and any listeners. */
  private say(message: string): void {
    this.opts.onProgress?.(message);
    for (const fn of this.progressListeners) {
      try {
        fn(message);
      } catch {
        // A listener that throws is the listener's problem, not the browser's.
      }
    }
  }

  /**
   * Every page-type target the browser currently has open.
   *
   * A link with `target="_blank"` opens a tab husk was never attached to, so the
   * click appeared to do nothing at all -- the snapshot came back unchanged, the
   * URL came back unchanged, and the page the agent wanted was sitting in a tab
   * nobody could see. This is how it becomes visible, and `switchTab` is how it
   * becomes usable.
   */
  async tabs(): Promise<Array<{ targetId: string; url: string; title: string; active: boolean }>> {
    const page = await this.activePage();
    const conn = this.conn;
    if (!conn) return [];

    const res = await conn.send('Target.getTargets', {});
    const infos = Array.isArray(res['targetInfos']) ? (res['targetInfos'] as Array<Record<string, unknown>>) : [];
    return infos
      .filter((t) => t['type'] === 'page')
      .map((t) => ({
        targetId: String(t['targetId'] ?? ''),
        url: String(t['url'] ?? ''),
        title: String(t['title'] ?? ''),
        active: String(t['targetId'] ?? '') === page.id,
      }));
  }

  /**
   * Make another tab the one every other call acts on.
   *
   * The previous page object is dropped rather than kept in a list: one active
   * page keeps `activePage()` meaning exactly one thing, and a stale `Page`
   * handed out earlier would otherwise keep driving a tab the caller thinks
   * they have left.
   */
  async switchTab(targetId: string): Promise<{ url: string; title: string }> {
    const conn = this.conn;
    if (!conn) {
      throw new HuskError('E_TOOL_ERROR', 'the browser is not running', {
        hint: 'call goto first; the browser starts on demand',
      });
    }

    const known = await this.tabs();
    if (!known.some((t) => t.targetId === targetId)) {
      throw new HuskError('E_TOOL_ERROR', `no tab with id ${targetId}`, {
        hint: `open tabs are: ${known.map((t) => `${t.targetId} (${t.url})`).join(', ') || 'none'}`,
      });
    }

    const page = new Page(conn, targetId);
    await page.init();
    // Bring it to the front too, so a screenshot of it is not of a backgrounded
    // tab that has stopped rendering.
    await conn.send('Target.activateTarget', { targetId }).catch(() => undefined);
    this.page = page;
    this.touch();
    return { url: await page.url(), title: await page.title() };
  }

  /** Open a new tab and switch to it. */
  async newTab(url = 'about:blank'): Promise<{ targetId: string; url: string }> {
    await this.activePage();
    const conn = this.conn;
    if (!conn) throw new HuskError('E_TOOL_ERROR', 'the browser is not running', { hint: 'call goto first' });

    const targetId = await createTarget(conn, url);
    await this.switchTab(targetId);
    return { targetId, url };
  }

  private async launch(): Promise<Page> {
    const say = (m: string): void => this.say(m);

    this.chromium ??= await provisionChromium(this.computer, { onProgress: say });
    this.port = await this.startChromium(this.chromium.binary, say);

    const transport = this.opts.transport
      ? this.opts.transport(this.computer, this.port)
      : new ComputerDriverTransport(this.computer, this.port);
    const conn = new CdpConnection(transport);
    this.conn = conn;

    const targetId = await createTarget(conn, 'about:blank');
    const page = new Page(conn, targetId);
    await page.init();
    if (this.opts.viewport) await page.setViewport(this.opts.viewport.width, this.opts.viewport.height);

    this.page = page;
    this.touch();
    say(`Chromium is up on the computer's own 127.0.0.1:${this.port}`);
    warnIfDebugPortIsExposed(this.computer, this.port, say);
    return page;
  }

  /** Start the browser detached, and wait until its debugger answers -- from inside. */
  private async startChromium(binary: string, say: (m: string) => void): Promise<number> {
    const port = await this.freePort();
    const size = this.opts.viewport ?? { width: 1280, height: 800 };

    say('starting Chromium and waiting for its debugger');

    // Start and poll in ONE exec. Splitting them loses a race: the shell returns
    // the instant it has backgrounded the job, the provider tears the invocation
    // down, and a 100 MB binary that has not finished exec(2) yet goes with it.
    // That failure looks exactly like "Chromium is broken" and is not.
    //
    // stdio goes to a file rather than being inherited, because `exec` resolves
    // when the pipes close and a background child holding stdout open would hang
    // the call forever. `--no-sandbox` is not carelessness: the computer *is* the
    // sandbox, and Chromium's namespace sandbox cannot nest inside an
    // unprivileged container.
    //
    // The poll runs inside the machine because that is where the port is. It is
    // also the only place it ever will be -- there is no bind address flag here,
    // and there is not going to be one.
    //
    // `--window-size` rather than an Emulation override for the default, because
    // emulation is per-session and every driver invocation is a new session.
    const cmd =
      `mkdir -p ${PROFILE_DIR}; ` +
      `(setsid ${binary} --headless --disable-gpu --no-sandbox ` +
      `--remote-debugging-port=${port} --user-data-dir=${PROFILE_DIR} ` +
      `--window-size=${size.width},${size.height} ` +
      `about:blank >${LOG_PATH} 2>&1 </dev/null &) ; ` +
      `for i in $(seq 1 80); do ` +
      `curl -sf --max-time 2 -o /dev/null http://127.0.0.1:${port}/json/version && exit 0; ` +
      `sleep 0.5; done; exit 1`;

    const ready = await this.computer.exec({ cmd, timeoutSec: 120 });

    if (ready.exitCode !== 0) {
      const log = await this.computer.readTextFile(LOG_PATH, 4000).catch(() => '');
      throw new HuskError('E_COMPUTER_FAILED', 'Chromium started but never opened its debugging port', {
        hint: 'the log is in details -- a missing shared library or a stale singleton lock in the profile are the usual causes',
        details: { port, log: log.slice(-2000) },
      });
    }

    return port;
  }

  /** Ask the machine for a port nothing is listening on, rather than hoping 9222 is free. */
  private async freePort(): Promise<number> {
    const r = await this.computer
      .exec({
        cmd: `python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"`,
        timeoutSec: 30,
      })
      .catch(() => undefined);
    const port = Number(r?.stdout.trim());
    return Number.isInteger(port) && port > 1024 ? port : 9222;
  }

  async close(reason = 'closed'): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.page = undefined;
    await this.conn?.close(`the browser session was ${reason}`);
    this.conn = undefined;

    if (this.port) {
      // Killed by port rather than by pid: the pid we captured is the setsid
      // wrapper's, and Chromium reparents away from it immediately.
      await this.computer
        .exec({
          cmd: `pkill -f -- "--remote-debugging-port=${this.port}" || true`,
          timeoutSec: 30,
        })
        .catch(() => undefined);
      this.port = 0;
    }
  }
}

const sessions = new Map<string, BrowserSession>();

/** The session for this computer, created on first ask. */
export function browserFor(computer: Computer, opts: SessionOptions = {}): BrowserSession {
  const existing = sessions.get(computer.id);
  if (existing) return existing;
  const created = new BrowserSession(computer, opts);
  sessions.set(computer.id, created);
  return created;
}

export async function closeBrowserFor(computerId: string): Promise<void> {
  const s = sessions.get(computerId);
  if (!s) return;
  sessions.delete(computerId);
  await s.close('closed by request');
}

/**
 * Close this computer's browser when the computer is destroyed.
 *
 * Registered at module load, so it is in place before `browserFor` could have
 * created anything. Without it a destroyed machine left its Chromium running:
 * on the `local` provider those processes live on the host, so nothing reaps
 * them, and each one pins its workspace directory open -- which is why `husk
 * rm` would report "its files are still on disk" and mean it.
 */
onComputerDestroyed(async (computerId) => {
  await closeBrowserFor(computerId);
});

/**
 * And on the way out.
 *
 * A `husk serve` that is killed, or an MCP server whose client disconnects,
 * would otherwise leak exactly the same way. `beforeExit` does not fire on a
 * signal, so the signals are handled too -- without swallowing them: the
 * default behaviour is restored and the signal re-raised, so a supervisor still
 * sees the process die the way it expects.
 */
let exitWired = false;
function wireExitCleanup(): void {
  if (exitWired) return;
  exitWired = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void closeAllBrowsers().finally(() => {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      });
    });
  }
  process.once('beforeExit', () => {
    void closeAllBrowsers();
  });
}
wireExitCleanup();

export async function closeAllBrowsers(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.close('shutting down')));
}
