import { type ChildProcess, spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { HuskError, clampText, id as newId } from '@husk/core';
import type {
  Availability,
  Computer,
  ComputerInfo,
  ComputerProvider,
  ComputerSpec,
  DirEntry,
  ExecRequest,
  ExecResult,
  PortBinding,
  ProviderName,
  WriteFileOptions,
} from '@husk/core';
import { GUEST_ROOT, GUEST_TMP, OutputBuffer, evaluateCommand, normaliseGuestPath, shellQuote } from '../policy.js';
import { expired, forgetInfo, loadInfos, persistInfo } from '../registry.js';
import { parseLsLong } from './oci-common.js';

/**
 * A box you already own.
 *
 * This is the provider that keeps the free-tier promise honest for people who
 * want real isolation and cannot run Docker: an Oracle Cloud Always Free ARM
 * instance is free forever, and a Raspberry Pi on the shelf is cheaper than
 * that. Husk does not provision anything -- you point it at a host you can
 * already `ssh` into, and it treats a directory there as the computer.
 *
 * What it is honest about: the remote is isolated from *this* laptop, and it is
 * not isolated from itself. Commands run as your user on that box under the
 * same path jail and command policy the local provider uses. If you want a
 * container on the far end, install Docker there and point husk at the socket.
 *
 * Cost control: every ssh invocation carries `BatchMode=yes` (never prompt),
 * `ConnectTimeout`, and a hard local timeout, and N execs share one
 * ControlMaster connection rather than paying N TCP + crypto handshakes.
 */

export const REMOTE_ROOT = '.husk-work';

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

export interface SshTarget {
  user?: string;
  /** Bare hostname or IP. IPv6 is stored without brackets. */
  host: string;
  port?: number;
}

/**
 * Parse `user@host`, `user@host:port`, `user@[::1]:22`, or a bare host.
 *
 * The ambiguity worth getting right is IPv6: `::1:22` is a valid address and
 * also looks exactly like host:port. The rule OpenSSH itself uses is that an
 * unbracketed address with more than one colon is an address, full stop.
 */
export function parseSshTarget(raw: string): SshTarget {
  const input = raw.trim();
  if (!input) {
    throw new HuskError('E_CONFIG', 'empty ssh target', {
      hint: 'set HUSK_SSH_TARGET to something like user@host or user@host:22',
    });
  }

  // Split on the *last* @, so a password-ish user containing @ still parses.
  const at = input.lastIndexOf('@');
  const user = at > 0 ? input.slice(0, at) : undefined;
  let rest = at >= 0 ? input.slice(at + 1) : input;
  if (!rest) {
    throw new HuskError('E_CONFIG', `ssh target "${raw}" has no host`, {
      hint: 'use the form user@host or user@host:port',
    });
  }

  let host: string;
  let port: number | undefined;

  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) {
      throw new HuskError('E_CONFIG', `ssh target "${raw}" has an unclosed [`, {
        hint: 'bracket IPv6 addresses like user@[2001:db8::1]:22',
      });
    }
    host = rest.slice(1, close);
    const tail = rest.slice(close + 1);
    if (tail.startsWith(':')) port = parsePort(tail.slice(1), raw);
    else if (tail) {
      throw new HuskError('E_CONFIG', `ssh target "${raw}" has trailing junk after the address`, {
        hint: 'use the form user@[2001:db8::1]:22',
      });
    }
  } else if ((rest.match(/:/g) ?? []).length > 1) {
    host = rest; // unbracketed IPv6, no port
  } else {
    const colon = rest.indexOf(':');
    if (colon >= 0) {
      port = parsePort(rest.slice(colon + 1), raw);
      rest = rest.slice(0, colon);
    }
    host = rest;
  }

  if (!host) {
    throw new HuskError('E_CONFIG', `ssh target "${raw}" has no host`, {
      hint: 'use the form user@host or user@host:port',
    });
  }
  return { ...(user ? { user } : {}), host, ...(port !== undefined ? { port } : {}) };
}

function parsePort(text: string, raw: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new HuskError('E_CONFIG', `ssh target "${raw}" has an invalid port: ${text}`, {
      hint: 'the port must be an integer between 1 and 65535',
    });
  }
  return n;
}

/** `user@host` as ssh(1) wants it on the command line. Brackets are dropped. */
export function sshDestination(t: SshTarget): string {
  return t.user ? `${t.user}@${t.host}` : t.host;
}

/** `user@[host]:path` as scp(1) wants it. IPv6 must be bracketed here. */
export function scpRemote(t: SshTarget, path: string): string {
  const host = t.host.includes(':') ? `[${t.host}]` : t.host;
  return `${t.user ? `${t.user}@` : ''}${host}:${path}`;
}

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

export interface SshArgOptions {
  target: SshTarget;
  /** ControlMaster socket. Omit to disable connection sharing. */
  controlPath?: string;
  keyPath?: string;
  /** Build the argv for the master connection itself (`-M -N`). */
  master?: boolean;
  tty?: boolean;
  connectTimeoutSec?: number;
  /** Extra ssh options, inserted before the destination (e.g. -L for a forward). */
  extra?: string[];
  /** Remote command, appended after the destination. */
  command?: string;
}

/**
 * Every ssh invocation husk makes goes through here.
 *
 * `BatchMode=yes` is the important one: without it a misconfigured key turns an
 * agent tool call into a password prompt on a stdin nobody is reading, and the
 * process hangs until something kills it. `accept-new` trusts a host the first
 * time and refuses it if the key ever changes -- the same trade a human makes,
 * without the interactive question.
 */
export function buildSshArgs(o: SshArgOptions): string[] {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `ConnectTimeout=${o.connectTimeoutSec ?? 10}`,
    // A remote that vanishes must surface as a dead connection, not a hang.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];

  if (o.controlPath) {
    args.push('-o', `ControlMaster=${o.master ? 'yes' : 'auto'}`);
    args.push('-o', `ControlPath=${o.controlPath}`);
    // The master we spawn owns the socket's lifetime; a persist window only
    // exists so a race between master death and an exec still succeeds.
    args.push('-o', `ControlPersist=${o.master ? 'no' : '60'}`);
  }

  if (o.keyPath) {
    args.push('-i', o.keyPath);
    // Without this, ssh offers every key the agent holds first and can trip a
    // MaxAuthTries lockout before it reaches the one that was asked for.
    args.push('-o', 'IdentitiesOnly=yes');
  }

  if (o.target.port !== undefined) args.push('-p', String(o.target.port));
  if (o.master) args.push('-N');
  // -tt forces a pty even though our stdin is a pipe; -T guarantees none, so a
  // remote motd or a shell that echoes cannot corrupt captured output.
  args.push(o.tty ? '-tt' : '-T');
  if (o.extra) args.push(...o.extra);

  args.push(sshDestination(o.target));
  if (o.command !== undefined) args.push(o.command);
  return args;
}

export function buildScpArgs(o: {
  target: SshTarget;
  controlPath?: string;
  keyPath?: string;
  source: string;
  dest: string;
  recursive?: boolean;
  connectTimeoutSec?: number;
}): string[] {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `ConnectTimeout=${o.connectTimeoutSec ?? 10}`,
  ];
  if (o.controlPath) {
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${o.controlPath}`, '-o', 'ControlPersist=60');
  }
  if (o.keyPath) args.push('-i', o.keyPath, '-o', 'IdentitiesOnly=yes');
  // scp spells the port -P, unlike every other tool in the suite.
  if (o.target.port !== undefined) args.push('-P', String(o.target.port));
  if (o.recursive) args.push('-r');
  args.push(o.source, o.dest);
  return args;
}

// ---------------------------------------------------------------------------
// The remote path jail
// ---------------------------------------------------------------------------

export interface RemoteJail {
  /** Absolute remote directory backing /work. */
  root: string;
  /** Absolute remote directory backing /tmp. */
  tmp: string;
}

export function jailFor(baseDir: string): RemoteJail {
  return { root: posix.join(baseDir, 'work'), tmp: posix.join(baseDir, 'tmp') };
}

/**
 * Guest path -> remote path, refusing anything that escapes the jail.
 *
 * This is `toHostPath` from policy.ts with POSIX semantics pinned: the remote is
 * always Linux, and running node's platform-dependent `resolve` against a remote
 * path from a Windows laptop turns `/work/a` into `C:\work\a`. The rules -- the
 * normalisation, the two mount points, the containment test after `..` collapse
 * -- are the same ones the local provider enforces.
 */
export function toRemotePath(guestPath: string, jail: RemoteJail, cwd: string = GUEST_ROOT): string {
  const g = normaliseGuestPath(guestPath, cwd);

  for (const [prefix, base] of [
    [GUEST_ROOT, jail.root],
    [GUEST_TMP, jail.tmp],
  ] as const) {
    if (g === prefix || g.startsWith(prefix + '/')) {
      const rel = g.slice(prefix.length).replace(/^\//, '');
      const resolved = posix.normalize(rel ? posix.join(base, rel) : base);
      if (resolved !== base && !resolved.startsWith(base + '/')) {
        throw new HuskError('E_FS_DENIED', `path escapes the workspace: ${guestPath}`, {
          hint: `paths must stay inside ${GUEST_ROOT} or ${GUEST_TMP}`,
        });
      }
      return resolved;
    }
  }

  throw new HuskError('E_FS_DENIED', `path is outside the machine's writable area: ${g}`, {
    hint: `this computer exposes ${GUEST_ROOT} and ${GUEST_TMP}; use a path under one of them`,
    details: { path: g },
  });
}

/** Remote path -> what the agent should see. Best effort, for listings. */
export function toGuestRemotePath(remotePath: string, jail: RemoteJail): string {
  const p = posix.normalize(remotePath);
  for (const [prefix, base] of [
    [GUEST_ROOT, jail.root],
    [GUEST_TMP, jail.tmp],
  ] as const) {
    if (p === base) return prefix;
    if (p.startsWith(base + '/')) return posix.join(prefix, p.slice(base.length + 1));
  }
  return p;
}

/** Exit code the remote guard uses. Distinct so it cannot be confused with the command's. */
export const JAIL_EXIT = 77;

/**
 * The symlink check, done on the far end.
 *
 * `toRemotePath` is lexical -- it catches `..` and absolute escapes but cannot
 * see a symlink inside the workspace pointing at /etc. The local provider calls
 * `assertInJail`, which resolves the path with `realpath`. We cannot do that from
 * here without a round trip per operation, so the resolution happens inside the
 * same shell command that does the work.
 */
export function remoteJailGuard(remotePath: string, jail: RemoteJail): string {
  const q = shellQuote([remotePath]);
  const root = shellQuote([jail.root]);
  const tmp = shellQuote([jail.tmp]);
  return (
    `__h=${q}; ` +
    // readlink -f resolves a path that does not exist yet, as long as its parent does.
    `__r=$(readlink -f "$__h" 2>/dev/null || printf %s "$__h"); ` +
    `case "$__r" in ${root}|${root}/*|${tmp}|${tmp}/*) ;; ` +
    `*) echo "husk: path resolves outside the workspace: $__h" >&2; exit ${JAIL_EXIT};; esac; `
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SshSettings {
  target: SshTarget;
  keyPath?: string;
}

/**
 * Where the target comes from: the husk that asked, then the environment.
 *
 * Per-spec first, so one machine can drive several boxes; env second, so the
 * common case is one variable and no config file.
 */
export function resolveSshSettings(
  spec: ComputerSpec | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SshSettings | null {
  const raw = spec?.labels?.['husk.ssh'] ?? env.HUSK_SSH_TARGET;
  if (!raw || !raw.trim()) return null;
  const keyPath = spec?.labels?.['husk.ssh.key'] ?? env.HUSK_SSH_KEY;
  return { target: parseSshTarget(raw), ...(keyPath ? { keyPath } : {}) };
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  raw: Buffer;
  timedOut: boolean;
  truncated: boolean;
}

interface RunOpts {
  timeoutMs: number;
  stdin?: Buffer | string;
  maxOutputBytes?: number;
  /** Collect stdout as bytes rather than a clamped string. For readFile. */
  binary?: boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Run one ssh/scp process to completion, and never leave it behind.
 *
 * Every exit path clears the timer, drops the abort listener and kills the
 * child. `ssh` with BatchMode still blocks on a black-holed TCP connection until
 * ConnectTimeout, and a remote that stops reading stdin can wedge a write, so the
 * local timeout is the backstop that makes "never hang" true rather than likely.
 */
function run(file: string, args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise((settle) => {
    const maxBytes = opts.maxOutputBytes ?? 256 * 1024;
    const out = new OutputBuffer(maxBytes);
    const err = new OutputBuffer(maxBytes);
    const chunks: Buffer[] = [];
    let rawBytes = 0;
    let timedOut = false;
    let done = false;

    const child = spawn(file, args, { windowsHide: true });

    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };

    const onAbort = () => {
      timedOut = true;
      kill();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);

    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      settle({
        code,
        stdout: out.toString(),
        stderr: err.toString(),
        raw: Buffer.concat(chunks),
        timedOut,
        truncated: out.truncated || err.truncated,
      });
    };

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (c: Buffer) => {
      if (opts.binary) {
        if (rawBytes + c.byteLength <= maxBytes) {
          chunks.push(c);
          rawBytes += c.byteLength;
        }
      } else {
        out.push(c);
      }
      opts.onStdout?.(c.toString('utf8'));
    });
    child.stderr?.on('data', (c: Buffer) => {
      err.push(c);
      opts.onStderr?.(c.toString('utf8'));
    });

    // A remote that dies mid-write closes the channel; the resulting EPIPE must
    // not escape as an unhandled 'error' event.
    child.stdin?.on('error', () => {});
    child.on('error', (e) => {
      err.push(Buffer.from(`\n${file}: ${e.message}`, 'utf8'));
      finish((e as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 255);
    });
    child.on('close', (code, signal) => finish(timedOut ? 124 : (code ?? (signal ? 137 : 255))));

    if (opts.stdin !== undefined && child.stdin) child.stdin.end(opts.stdin);
    else child.stdin?.end();
  });
}

/** Masters we have opened, so a process exit cannot strand one. */
const openMasters = new Set<ControlMaster>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const killAll = () => {
    for (const m of openMasters) m.killNow();
    openMasters.clear();
  };
  process.on('exit', killAll);
}

/**
 * One long-lived ssh connection, shared by every exec on this computer.
 *
 * Without it, twenty tool calls mean twenty TCP handshakes plus twenty key
 * exchanges -- roughly a second each on a transatlantic link, which is most of
 * an agent's turn spent on cryptography it already did.
 *
 * The master is a child process we own rather than `ssh -f`, because a
 * backgrounded ssh is a process we can no longer reap.
 */
class ControlMaster {
  readonly socket: string | undefined;
  private child: ChildProcess | undefined;
  private opening: Promise<void> | undefined;

  constructor(
    private readonly settings: SshSettings,
    socket: string | undefined,
  ) {
    this.socket = socket;
  }

  /** Connection sharing needs a unix socket, which Windows OpenSSH does not have. */
  static socketFor(id: string): string | undefined {
    if (process.platform === 'win32') return undefined;
    // Short on purpose: macOS caps a unix socket path at 104 bytes, and a long
    // TMPDIR plus a long id silently truncates into a socket nothing can bind.
    return join(tmpdir(), `hk-${id.slice(-10)}.sock`);
  }

  async open(): Promise<void> {
    if (!this.socket) return;
    if (this.child && !this.child.killed) return;
    this.opening ??= this.spawnMaster().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async spawnMaster(): Promise<void> {
    const args = buildSshArgs({
      target: this.settings.target,
      ...(this.settings.keyPath ? { keyPath: this.settings.keyPath } : {}),
      controlPath: this.socket as string,
      master: true,
    });
    const child = spawn('ssh', args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    // The master must not hold a CLI process open after the work is done.
    child.unref();
    this.child = child;
    installExitHook();
    openMasters.add(this);

    // `ssh -M -N` does not tell us when the socket is ready, so poll `-O check`.
    // Failure is not fatal: every exec uses ControlMaster=auto and simply opens
    // its own connection when the socket is not there.
    for (let i = 0; i < 20; i++) {
      const r = await run('ssh', this.controlArgs('check'), { timeoutMs: 5000 });
      if (r.code === 0) return;
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) return;
      await sleep(250);
    }
  }

  private controlArgs(cmd: 'check' | 'exit'): string[] {
    return buildSshArgs({
      target: this.settings.target,
      ...(this.settings.keyPath ? { keyPath: this.settings.keyPath } : {}),
      controlPath: this.socket as string,
      extra: ['-O', cmd],
    });
  }

  /** Drop a socket the far end has forgotten about, so the next open can rebuild it. */
  async reset(): Promise<void> {
    if (!this.socket) return;
    this.killNow();
    await unlink(this.socket).catch(() => {});
    await this.open();
  }

  async close(): Promise<void> {
    openMasters.delete(this);
    if (!this.socket) return;
    await run('ssh', this.controlArgs('exit'), { timeoutMs: 8000 }).catch(() => {});
    this.killNow();
    await unlink(this.socket).catch(() => {});
  }

  killNow(): void {
    if (!this.child) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    this.child = undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}

/** ssh's own complaints about a dead or stale control socket. */
export function isStaleSocket(stderr: string): boolean {
  return /control socket|controlpath|multiplexing|mux_client|no such file or directory.*\.sock/i.test(stderr);
}

type RemoteOpts = RunOpts & { tty?: boolean; extra?: string[] };

/**
 * Run one remote command, retrying once through a rebuilt master.
 *
 * A ControlMaster socket outlives crashes, suspends and network changes, and a
 * stale one makes ssh fail in a way that has nothing to do with the command.
 * One rebuild-and-retry turns that into a slow call instead of an error.
 */
async function runRemote(
  settings: SshSettings,
  master: ControlMaster,
  command: string,
  opts: RemoteOpts,
): Promise<RunResult> {
  const argv = () =>
    buildSshArgs({
      target: settings.target,
      ...(settings.keyPath ? { keyPath: settings.keyPath } : {}),
      ...(master.socket ? { controlPath: master.socket } : {}),
      ...(opts.tty ? { tty: true } : {}),
      ...(opts.extra ? { extra: opts.extra } : {}),
      command,
    });

  const first = await run('ssh', argv(), opts);
  if (first.code !== 0 && master.socket && isStaleSocket(first.stderr)) {
    await master.reset();
    return await run('ssh', argv(), opts);
  }
  return first;
}

// ---------------------------------------------------------------------------
// The computer
// ---------------------------------------------------------------------------

class SshComputer implements Computer {
  readonly info: ComputerInfo;
  private readonly settings: SshSettings;
  private readonly jail: RemoteJail;
  private readonly master: ControlMaster;
  private readonly forwards = new Map<number, { binding: PortBinding; child: ChildProcess }>();
  private destroyed = false;

  constructor(info: ComputerInfo, settings: SshSettings, master?: ControlMaster) {
    this.info = info;
    this.settings = settings;
    this.jail = jailFor(this.baseDir);
    this.master = master ?? new ControlMaster(settings, ControlMaster.socketFor(info.id));
  }

  get id(): string {
    return this.info.id;
  }

  private get baseDir(): string {
    const dir = this.info.nativeId;
    if (!dir) {
      throw new HuskError('E_COMPUTER_NOT_FOUND', `computer ${this.info.id} has no remote directory`, {
        hint: 'create a new one with `husk up`',
      });
    }
    return dir;
  }

  private assertLive(): void {
    if (this.destroyed || this.info.state === 'destroyed') {
      throw new HuskError('E_COMPUTER_NOT_FOUND', `computer ${this.info.id} has been destroyed`, {
        hint: 'create a new one with `husk up`',
      });
    }
  }

  private remote(command: string, opts: RemoteOpts): Promise<RunResult> {
    return runRemote(this.settings, this.master, command, opts);
  }

  async refresh(): Promise<ComputerInfo> {
    if (this.destroyed) {
      this.info.state = 'destroyed';
      return this.info;
    }
    const r = await this.remote(`test -d ${shellQuote([this.baseDir])}`, { timeoutMs: 20_000 });
    if (r.code === 0) this.info.state = 'running';
    else if (r.code === 1) this.info.state = 'destroyed';
    else this.info.state = 'error';
    return this.info;
  }

  private touch(): void {
    this.info.lastUsedAt = new Date().toISOString();
    void persistInfo(this.info).catch(() => {});
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    this.assertLive();
    const started = Date.now();

    const labels = this.info.spec.labels ?? {};
    const decision = evaluateCommand(req.cmd, {
      deny: splitList(labels['husk.denyCommands']),
      allow: splitList(labels['husk.allowCommands']),
    });
    if (!decision.allowed) {
      throw new HuskError('E_EXEC_DENIED', `refused: ${decision.reason}`, {
        hint: 'add a pattern to guardrails.allowCommands in husk.yaml if this is intentional',
        details: { rule: decision.rule, cmd: req.cmd },
      });
    }

    const cwd = toRemotePath(req.cwd ?? GUEST_ROOT, this.jail);
    const script = typeof req.cmd === 'string' ? req.cmd : shellQuote(req.cmd);
    // Only what the spec asked for. Nothing from this laptop's environment goes
    // over the wire -- the remote already has its own, and ours holds secrets.
    const env: Record<string, string> = { ...this.info.spec.env, ...req.env, HUSK: '1' };
    const assignments = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote([v])}`)
      .join(' ');

    const command =
      `mkdir -p ${shellQuote([cwd])} && cd ${shellQuote([cwd])} && ` +
      `exec env ${assignments} /bin/sh -c ${shellQuote([script])}`;

    const timeoutSec = req.timeoutSec ?? 120;
    const r = await this.remote(command, {
      // The local kill is the backstop; closing the channel is what actually
      // stops the remote, because sshd HUPs the session when the channel dies.
      timeoutMs: (timeoutSec > 0 ? timeoutSec : 3600) * 1000,
      ...(req.maxOutputBytes !== undefined ? { maxOutputBytes: req.maxOutputBytes } : {}),
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.onStdout ? { onStdout: req.onStdout } : {}),
      ...(req.onStderr ? { onStderr: req.onStderr } : {}),
      ...(req.tty ? { tty: true } : {}),
    });

    this.touch();
    return {
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: Date.now() - started,
      truncated: r.truncated,
      timedOut: r.timedOut,
    };
  }

  /** Run a filesystem command with the symlink guard in front of it. */
  private async guarded(guestPath: string, body: (remote: string) => string, opts: Partial<RunOpts> = {}) {
    const remote = toRemotePath(guestPath, this.jail);
    const r = await this.remote(remoteJailGuard(remote, this.jail) + body(remote), {
      timeoutMs: 60_000,
      ...opts,
    });
    if (r.code === JAIL_EXIT) {
      throw new HuskError('E_FS_DENIED', 'path resolves outside the workspace through a symlink', {
        hint: 'husk refuses to follow links that leave the machine',
        details: { path: guestPath },
      });
    }
    return { remote, ...r };
  }

  async writeFile(path: string, content: string | Uint8Array, opts: WriteFileOptions = {}): Promise<void> {
    this.assertLive();
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const r = await this.guarded(
      path,
      (remote) => {
        const q = shellQuote([remote]);
        const mkdir = opts.mkdirp === false ? '' : `mkdir -p ${shellQuote([posix.dirname(remote)])} && `;
        const chmod = opts.mode ? ` && chmod ${shellQuote([opts.mode])} ${q}` : '';
        return `${mkdir}cat ${opts.append ? '>>' : '>'} ${q}${chmod}`;
      },
      { stdin: data, timeoutMs: 120_000 },
    );
    if (r.code !== 0) {
      throw new HuskError('E_FS_DENIED', `cannot write ${normaliseGuestPath(path)}: ${r.stderr.trim()}`, {
        hint: 'check the remote user can write there and the disk is not full',
      });
    }
    this.touch();
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertLive();
    const r = await this.guarded(path, (remote) => `cat ${shellQuote([remote])}`, {
      binary: true,
      maxOutputBytes: 32 * 1024 * 1024,
      timeoutMs: 120_000,
    });
    if (r.code !== 0) {
      throw new HuskError('E_FS_DENIED', `cannot read ${normaliseGuestPath(path)}: ${r.stderr.trim()}`, {
        hint: 'check the path exists on the remote',
      });
    }
    this.touch();
    return new Uint8Array(r.raw);
  }

  async readTextFile(path: string, maxBytes = 1024 * 1024): Promise<string> {
    const buf = await this.readFile(path);
    return clampText(Buffer.from(buf).toString('utf8'), maxBytes).text;
  }

  async listDir(path: string): Promise<DirEntry[]> {
    this.assertLive();
    const r = await this.guarded(path, (remote) => `ls -lA ${shellQuote([remote])}`);
    if (r.code !== 0) {
      throw new HuskError('E_FS_DENIED', `cannot list ${normaliseGuestPath(path)}: ${r.stderr.trim()}`, {
        hint: 'check the directory exists on the remote',
      });
    }
    this.touch();
    const entries = parseLsLong(r.stdout, toGuestRemotePath(r.remote, this.jail));
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return entries;
  }

  async stat(path: string): Promise<DirEntry | null> {
    this.assertLive();
    const r = await this.guarded(path, (remote) => `stat -c '%s|%F|%a|%Y' ${shellQuote([remote])}`);
    if (r.code !== 0) return null;
    const [size, kind, mode, mtime] = r.stdout.trim().split('|');
    const guest = toGuestRemotePath(r.remote, this.jail);
    return {
      name: posix.basename(guest),
      path: guest,
      type: kind?.includes('directory') ? 'dir' : kind?.includes('symbolic') ? 'symlink' : kind?.includes('regular') ? 'file' : 'other',
      size: Number.parseInt(size ?? '0', 10) || 0,
      ...(mtime ? { modifiedAt: new Date(Number(mtime) * 1000).toISOString() } : {}),
      ...(mode ? { mode } : {}),
    };
  }

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    this.assertLive();
    const target = toRemotePath(path, this.jail);
    if (target === this.jail.root) {
      throw new HuskError('E_FS_DENIED', 'refusing to delete the workspace root', {
        hint: 'use `husk rm <computer>` to destroy the whole machine',
      });
    }
    const r = await this.guarded(path, (remote) => `rm ${opts.recursive ? '-rf' : '-f'} ${shellQuote([remote])}`);
    if (r.code !== 0) {
      throw new HuskError('E_FS_DENIED', `cannot remove ${normaliseGuestPath(path)}: ${r.stderr.trim()}`, {
        hint: 'check the remote user owns the path',
      });
    }
    this.touch();
  }

  async upload(hostPath: string, targetPath: string): Promise<void> {
    this.assertLive();
    const remote = toRemotePath(targetPath, this.jail);
    const mk = await this.remote(`mkdir -p ${shellQuote([posix.dirname(remote)])}`, { timeoutMs: 30_000 });
    if (mk.code !== 0) {
      throw new HuskError('E_FS_DENIED', `cannot create the destination directory: ${mk.stderr.trim()}`, {
        hint: 'check the remote user can write into the workspace',
      });
    }
    const r = await run(
      'scp',
      buildScpArgs({
        target: this.settings.target,
        ...(this.settings.keyPath ? { keyPath: this.settings.keyPath } : {}),
        ...(this.master.socket ? { controlPath: this.master.socket } : {}),
        source: hostPath,
        dest: scpRemote(this.settings.target, remote),
        recursive: true,
      }),
      { timeoutMs: 600_000 },
    );
    if (r.code !== 0) {
      throw new HuskError('E_FS_DENIED', `scp failed: ${r.stderr.trim()}`, {
        hint: 'check the local path exists and the remote has space',
      });
    }
    this.touch();
  }

  async download(path: string, hostPath: string): Promise<void> {
    this.assertLive();
    const remote = toRemotePath(path, this.jail);
    const r = await run(
      'scp',
      buildScpArgs({
        target: this.settings.target,
        ...(this.settings.keyPath ? { keyPath: this.settings.keyPath } : {}),
        ...(this.master.socket ? { controlPath: this.master.socket } : {}),
        source: scpRemote(this.settings.target, remote),
        dest: hostPath,
        recursive: true,
      }),
      { timeoutMs: 600_000 },
    );
    if (r.code !== 0) {
      throw new HuskError('E_FS_DENIED', `scp failed: ${r.stderr.trim()}`, {
        hint: 'check the remote path exists',
      });
    }
    this.touch();
  }

  /**
   * Tunnel a remote port back to this machine.
   *
   * `ssh -L` cannot report the port it picked when asked for 0, so we choose a
   * free one ourselves. Binding and immediately releasing leaves a window where
   * something else could take it; ssh fails loudly if that happens, which is the
   * right outcome for a race this unlikely.
   */
  async exposePort(port: number): Promise<PortBinding> {
    this.assertLive();
    const existing = this.forwards.get(port);
    if (existing) return existing.binding;

    const hostPort = await freeLocalPort();
    const args = buildSshArgs({
      target: this.settings.target,
      ...(this.settings.keyPath ? { keyPath: this.settings.keyPath } : {}),
      ...(this.master.socket ? { controlPath: this.master.socket } : {}),
      master: true,
      extra: ['-L', `127.0.0.1:${hostPort}:127.0.0.1:${port}`],
    });
    const child = spawn('ssh', args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();

    const binding: PortBinding = { hostPort, url: `http://127.0.0.1:${hostPort}` };
    this.forwards.set(port, { binding, child });
    this.info.ports = { ...(this.info.ports ?? {}), [port]: binding };
    await persistInfo(this.info).catch(() => {});
    return binding;
  }

  async stop(): Promise<void> {
    // There is no VM to power down: a directory on someone else's box has no
    // "off". Dropping the shared connection is the only thing stop can honestly
    // do, and it is worth doing -- it frees the socket and the remote sshd.
    this.closeForwards();
    await this.master.close();
    this.info.state = 'stopped';
    await persistInfo(this.info);
  }

  async start(): Promise<void> {
    this.assertLive();
    await this.master.open();
    this.info.state = 'running';
    await persistInfo(this.info);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closeForwards();
    const dir = this.info.nativeId;
    if (dir) {
      // Guarded by construction: the path was built from ~/.husk-work/<id>, and
      // a computer whose id is empty would have failed at create time.
      await this.remote(`rm -rf ${shellQuote([dir])}`, { timeoutMs: 120_000 }).catch(() => {});
    }
    await this.master.close();
    this.info.state = 'destroyed';
    await forgetInfo(this.info.id);
  }

  private closeForwards(): void {
    for (const { child } of this.forwards.values()) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.forwards.clear();
  }
}

function splitList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v.split('\u0000').filter(Boolean);
}

function freeLocalPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => (port ? res(port) : rej(new Error('could not find a free local port'))));
    });
  });
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export class SshProvider implements ComputerProvider {
  readonly name: ProviderName = 'ssh';
  readonly description = 'A Linux box you already own, reached over ssh. Free if the box is.';
  readonly priority = 16;

  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: { env?: NodeJS.ProcessEnv } = {}) {
    this.env = opts.env ?? process.env;
  }

  /**
   * Never throws, never hangs, and never says "not available" without saying
   * what to type next.
   */
  async isAvailable(): Promise<Availability> {
    let settings: SshSettings | null;
    try {
      settings = resolveSshSettings(undefined, this.env);
    } catch (err) {
      return {
        available: false,
        isolated: true,
        isolationKind: 'machine',
        reason: (err as Error).message,
        hint: (err as HuskError).hint ?? 'set HUSK_SSH_TARGET to user@host or user@host:port',
      };
    }

    if (!settings) {
      return {
        available: false,
        isolated: true,
        isolationKind: 'machine',
        reason: 'no remote host is configured',
        hint: 'export HUSK_SSH_TARGET=user@host (an Oracle Cloud Always Free ARM instance costs nothing)',
      };
    }

    const args = buildSshArgs({
      target: settings.target,
      ...(settings.keyPath ? { keyPath: settings.keyPath } : {}),
      command: 'echo husk-ssh-ok; uname -sm',
    });
    const r = await run('ssh', args, { timeoutMs: 20_000 });

    if (r.code === 0 && r.stdout.includes('husk-ssh-ok')) {
      const uname = r.stdout.split('\n')[1]?.trim() ?? '';
      return {
        available: true,
        isolated: true,
        isolationKind: 'machine',
        version: `${sshDestination(settings.target)}${uname ? ` (${uname})` : ''}`,
        reason: 'commands run as your user on that box -- isolated from this machine, not from itself',
      };
    }

    return { available: false, isolated: true, ...diagnoseSsh(r, settings) };
  }

  async create(spec: ComputerSpec): Promise<Computer> {
    const settings = resolveSshSettings(spec, this.env);
    if (!settings) {
      throw new HuskError('E_PROVIDER_UNAVAILABLE', 'no ssh target is configured', {
        hint: 'export HUSK_SSH_TARGET=user@host, or set labels."husk.ssh" in husk.yaml',
      });
    }

    const id = newId('cmp');
    // One handshake up front, handed to the computer so every later exec reuses it.
    const master = new ControlMaster(settings, ControlMaster.socketFor(id));
    await master.open();

    // `$HOME` is resolved on the remote rather than assumed: the jail check needs
    // a literal absolute path, and `~` only exists inside a shell.
    const probe = await runRemote(
      settings,
      master,
      `set -e; d="$HOME/${REMOTE_ROOT}/${id}"; mkdir -p "$d/work" "$d/tmp"; ` +
        `chmod 700 "$HOME/${REMOTE_ROOT}" "$d"; printf %s "$d"`,
      { timeoutMs: 30_000 },
    );
    if (probe.code !== 0 || !probe.stdout.trim().startsWith('/')) {
      await master.close();
      throw new HuskError('E_COMPUTER_FAILED', `could not create the remote workspace: ${probe.stderr.trim() || `exit ${probe.code}`}`, {
        hint: 'check the remote user has a home directory it can write to',
      });
    }

    const now = new Date().toISOString();
    const info: ComputerInfo = {
      id,
      name: spec.name ?? id,
      provider: 'ssh',
      state: 'running',
      image: `ssh:${sshDestination(settings.target)}`,
      workdir: spec.workdir ?? GUEST_ROOT,
      createdAt: now,
      lastUsedAt: now,
      nativeId: probe.stdout.trim(),
      spec: {
        ...spec,
        provider: 'ssh',
        labels: { ...(spec.labels ?? {}), 'husk.ssh': rawTarget(settings) },
      },
    };
    await persistInfo(info);

    const computer = new SshComputer(info, settings, master);
    if (spec.setup) await computer.exec({ cmd: spec.setup, timeoutSec: 300 });
    return computer;
  }

  async get(id: string): Promise<Computer | null> {
    const info = (await loadInfos('ssh')).find((i) => i.id === id || i.name === id);
    if (!info || info.state === 'destroyed') return null;
    const settings = resolveSshSettings(info.spec, this.env);
    if (!settings) return null;
    return new SshComputer(info, settings);
  }

  async list(): Promise<ComputerInfo[]> {
    return (await loadInfos('ssh')).filter((i) => i.state !== 'destroyed');
  }

  async reap(): Promise<string[]> {
    const removed: string[] = [];
    for (const info of expired(await this.list())) {
      const c = await this.get(info.id).catch(() => null);
      if (!c) continue;
      await c.destroy().catch(() => {});
      removed.push(info.id);
    }
    return removed;
  }
}

function rawTarget(s: SshSettings): string {
  const host = s.target.host.includes(':') ? `[${s.target.host}]` : s.target.host;
  return `${s.target.user ? `${s.target.user}@` : ''}${host}${s.target.port ? `:${s.target.port}` : ''}`;
}

/** Turn ssh's stderr into one line the user can act on. */
export function diagnoseSsh(r: { code: number; stderr: string; timedOut: boolean }, s: SshSettings): {
  reason: string;
  hint: string;
} {
  const e = r.stderr;
  const dest = sshDestination(s.target);

  if (r.code === 127) {
    return {
      reason: 'the ssh client is not on PATH',
      hint:
        process.platform === 'win32'
          ? 'install the OpenSSH client: Settings > Apps > Optional Features > OpenSSH Client'
          : 'install openssh-client with your package manager',
    };
  }
  if (r.timedOut) {
    return {
      reason: `${dest} did not answer in time`,
      hint: 'check the host is up and port 22 is open to you (a cloud security list is the usual culprit)',
    };
  }
  if (/permission denied|no supported authentication|too many authentication/i.test(e)) {
    return {
      reason: `${dest} refused the key`,
      hint: s.keyPath
        ? `check ${s.keyPath} is the right key and is mode 600`
        : 'set HUSK_SSH_KEY to the private key for that host, or add it to your ssh-agent',
    };
  }
  if (/could not resolve hostname|name or service not known|nodename nor servname/i.test(e)) {
    return { reason: `cannot resolve ${s.target.host}`, hint: 'check the hostname, or use the IP address' };
  }
  if (/connection refused/i.test(e)) {
    return {
      reason: `${dest} refused the connection`,
      hint: 'check sshd is running and listening on the port you gave',
    };
  }
  if (/host key verification failed|remote host identification has changed/i.test(e)) {
    return {
      reason: `${dest} presented a different host key than last time`,
      hint: 'if you rebuilt the box, remove its line from ~/.ssh/known_hosts; otherwise stop and investigate',
    };
  }
  if (/connection timed out|no route to host|network is unreachable/i.test(e)) {
    return { reason: `cannot reach ${dest}`, hint: 'check the firewall or security group allows your IP on port 22' };
  }
  return {
    reason: `ssh to ${dest} failed: ${(e.split('\n').find((l) => l.trim()) ?? `exit ${r.code}`).slice(0, 140)}`,
    hint: `run \`ssh ${dest}\` by hand to see the full error`,
  };
}
