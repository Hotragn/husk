import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HuskError, clampText, ensurePaths, id as newId, paths } from '@husk/core';
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
import { loadInfos, persistInfo as persist } from '../registry.js';
import {
  GUEST_ROOT,
  GUEST_TMP,
  type JailMap,
  OutputBuffer,
  assertInJail,
  evaluateCommand,
  normaliseGuestPath,
  scrubEnv,
  shellQuote,
  toGuestPath,
  toHostPath,
} from '../policy.js';

/**
 * The always-available provider.
 *
 * This is NOT a sandbox. It is a guarded working directory: the path jail, the
 * scrubbed environment, the command policy and the output caps stop accidents,
 * and they will not stop an adversary. A prompt-injected model is closer to an
 * adversary than to an accident, so `isolated` is false and every surface that
 * reports a provider says so.
 *
 * What it does guarantee is that the free path works everywhere -- including a
 * Windows laptop with no Docker -- and that an agent sees the same `/work`
 * filesystem it would see inside a container.
 */

type ShellKind = 'wsl' | 'posix' | 'windows';

interface ShellPlan {
  kind: ShellKind;
  /** WSL distro name, when kind === 'wsl'. */
  distro?: string;
  label: string;
}

let cachedShell: ShellPlan | undefined;
/** When the cached plan is a recoverable downgrade, the time we settled on it. */
let downgradedAt: number | undefined;

/**
 * How long to sit on a WSL downgrade before looking again.
 *
 * WSL dies with "Wsl/Service/E_UNEXPECTED" and comes back after a
 * `wsl --shutdown` or a service restart. A long-running `husk serve` that
 * cached `cmd.exe` at the wrong moment would keep handing out a Windows shell
 * for the rest of its life, long after Linux was available again.
 */
const DOWNGRADE_RECHECK_MS = 60_000;

/**
 * Decide how to run a command.
 *
 * On Windows we prefer WSL, because a product that promises a Linux computer and
 * hands back `cmd.exe` has not delivered one. Falling back to the host shell is
 * better than failing, but it is reported rather than papered over -- and it is
 * treated as temporary unless WSL is genuinely absent.
 */
export function detectShell(force = false): ShellPlan {
  const stale =
    cachedShell?.kind === 'windows' &&
    downgradedAt !== undefined &&
    Date.now() - downgradedAt > DOWNGRADE_RECHECK_MS;
  if (cachedShell && !force && !stale) return cachedShell;

  if (process.platform !== 'win32') {
    cachedShell = { kind: 'posix', label: '/bin/sh on the host' };
    return cachedShell;
  }

  let sawDistro = false;
  try {
    const out = spawnSync('wsl.exe', ['-l', '-q'], { timeout: 8000, windowsHide: true });
    if (out.status === 0 && out.stdout) {
      // WSL emits UTF-16LE with NULs. Distro names are ASCII in every case that
      // matters, so stripping NULs is more robust than guessing the encoding.
      const distros = out.stdout
        .toString('utf8')
        .replace(/\0/g, '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('docker-desktop'));
      sawDistro = distros.length > 0;

      // Being listed is not the same as working. A distro can be registered and
      // still fail with "Catastrophic failure / Wsl/Service/E_UNEXPECTED", and
      // wsl.exe exits 0 while printing it -- so trust the marker, not the code.
      for (const distro of distros) {
        if (wslWorks(distro)) {
          downgradedAt = undefined;
          cachedShell = { kind: 'wsl', distro, label: `WSL2 (${distro})` };
          return cachedShell;
        }
      }
    }
  } catch {
    // fall through to the host shell
  }

  // A registered-but-broken distro is worth re-checking; a machine with no WSL
  // at all is not going to grow one mid-run, so that answer is cached for good.
  downgradedAt = sawDistro ? Date.now() : undefined;
  cachedShell = {
    kind: 'windows',
    label: sawDistro
      ? 'Windows host shell -- WSL is installed but not responding; commands are NOT Linux'
      : 'Windows host shell (no WSL) -- commands are NOT Linux',
  };
  return cachedShell;
}

const WSL_MARKER = 'husk-wsl-ok';

function wslWorks(distro: string): boolean {
  try {
    const probe = spawnSync('wsl.exe', ['-d', distro, '-e', 'echo', WSL_MARKER], {
      timeout: 15_000,
      windowsHide: true,
    });
    return (probe.stdout?.toString('utf8') ?? '').replace(/\0/g, '').includes(WSL_MARKER);
  } catch {
    return false;
  }
}

/**
 * Re-probe and downgrade to the host shell.
 *
 * WSL can die underneath a long-running process. Rather than failing every
 * subsequent create, fall back and say so once.
 */
function downgradeFromWsl(reason: string): ShellPlan {
  // Timestamped, so `detectShell` re-probes once WSL has had a chance to recover.
  downgradedAt = Date.now();
  cachedShell = {
    kind: 'windows',
    label: `Windows host shell -- WSL stopped responding (${reason}); commands are NOT Linux`,
  };
  return cachedShell;
}

/**
 * Whether this distro can give an agent a real `/work`.
 *
 * The trick is a per-exec user + mount namespace (`unshare -mr`), inside which we
 * bind-mount the workspace onto `/work`. That is exactly how rootless containers
 * work: the agent is uid 0 inside the namespace, the files it creates are owned by
 * the real user outside it, and the mount disappears when the command exits, so two
 * computers can both have `/work` without seeing each other.
 *
 * The one prerequisite is an empty `/work` directory to mount onto, which cannot be
 * created from inside the namespace. We make it once, as root, and say so.
 */
let workMountpoint: Map<string, boolean> | undefined;

function ensureWorkMountpoint(distro: string): boolean {
  workMountpoint ??= new Map();
  const cached = workMountpoint.get(distro);
  if (cached !== undefined) return cached;

  const probe = spawnSync('wsl.exe', ['-d', distro, '-e', 'test', '-d', '/work'], {
    timeout: 8000,
    windowsHide: true,
  });
  if (probe.status === 0) {
    workMountpoint.set(distro, true);
    return true;
  }

  // One-time, disclosed: an empty directory owned by root, used only as a mount point.
  const make = spawnSync('wsl.exe', ['-u', 'root', '-d', distro, '-e', 'mkdir', '-p', '/work'], {
    timeout: 15000,
    windowsHide: true,
  });
  const ok = make.status === 0;
  workMountpoint.set(distro, ok);
  return ok;
}

/**
 * Where a WSL computer's workspace lives.
 *
 * Inside the distro, not on the Windows drive it used to sit on. Two reasons,
 * both measured on the machine this was written on:
 *
 *  - **Space.** `C:` had 5 GB free while the distro's own ext4 had 938 GB. Each
 *    computer's browser alone is a 111 MB download that unpacks to 325 MB, so
 *    three machines were enough to fill the host drive and take WSL and Docker
 *    down with it. The roomy filesystem was sitting there unused.
 *  - **Speed.** `/work` was a drvfs mount of a Windows directory, so every file
 *    the agent touched crossed the 9p boundary. Now the agent is on native ext4
 *    and only husk's own occasional reads cross, in the other direction.
 *
 * The host keeps plain `fs` access through `\\wsl.localhost\<distro>\...`, which
 * Windows serves for every distro -- verified here for binary round-trips,
 * recursive mkdir and rm, and at about 4 ms a write. So none of the file
 * operations had to be rewritten to shell out through `wsl.exe`.
 *
 * Returns null when the distro cannot answer, which is a downgrade signal, not
 * an error: the caller falls back to the Windows-side workspace it always used.
 */
function distroWorkspace(distro: string, id: string): { linux: string; host: string } | null {
  const linuxRoot = `$HOME/.husk/workspaces/${id}`;
  // One round trip: make it, then print both spellings of where it is. Asking
  // separately would double the cost of the slowest step in `create`.
  const made = spawnSync(
    'wsl.exe',
    [
      '-d',
      distro,
      '-e',
      'sh',
      '-c',
      `mkdir -p "${linuxRoot}/root" "${linuxRoot}/tmp" && chmod 700 "${linuxRoot}" && ` +
        `printf '%s\\n%s\\n' "$(cd "${linuxRoot}" && pwd)" "$(wslpath -w "$(cd "${linuxRoot}" && pwd)")"`,
    ],
    { timeout: 20_000, windowsHide: true },
  );

  if (made.status !== 0) return null;
  const [linux, host] = (made.stdout?.toString('utf8') ?? '')
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  // The UNC path is the load-bearing half: without it husk cannot read the
  // workspace at all, and a silent half-answer would surface much later as a
  // confusing ENOENT.
  if (!linux || !host || !host.startsWith('\\\\')) return null;
  return { linux, host };
}

/**
 * Host path -> WSL path.
 *
 * WSL fails transiently in ways that have nothing to do with the request --
 * "Catastrophic failure", a distro mid-restart, a busy vmcompute. A single
 * `wslpath` blip must not abort an agent's command, so this retries briefly
 * before giving up.
 */
function wslPath(distro: string, hostPath: string, attempts = 3): string {
  let lastDetail = '';
  for (let i = 0; i < attempts; i++) {
    const out = spawnSync('wsl.exe', ['-d', distro, '-e', 'wslpath', '-a', '-u', hostPath], {
      timeout: 8000,
      windowsHide: true,
    });
    const p = (out.stdout?.toString('utf8') ?? '').replace(/\0/g, '').trim();
    if (out.status === 0 && p) return p;
    lastDetail = (out.stderr?.toString('utf8') ?? '').replace(/\0/g, '').trim() || `exit ${out.status}`;
    if (i < attempts - 1) {
      // Synchronous backoff: this sits on the exec path and Atomics.wait is the
      // only way to pause without turning the whole call chain async.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (i + 1));
    }
  }
  throw new HuskError('E_COMPUTER_FAILED', `could not map ${hostPath} into the WSL filesystem`, {
    hint: 'run `wsl -e true` to check WSL is healthy, or use --provider docker',
    details: { detail: lastDetail },
  });
}

class LocalComputer implements Computer {
  readonly info: ComputerInfo;
  private readonly jail: JailMap;
  private shell: ShellPlan;
  private readonly wslPathCache = new Map<string, string>();
  private mountable: boolean;
  private destroyed = false;

  constructor(info: ComputerInfo, jail: JailMap, shell: ShellPlan) {
    this.info = info;
    this.jail = jail;
    this.shell = shell;
    this.mountable = shell.kind === 'wsl' && ensureWorkMountpoint(shell.distro as string);

    // Resolved once at create time and carried in the spec, so a running agent
    // never pays a wsl.exe round trip -- or risks its flakiness -- per command.
    const labels = info.spec.labels ?? {};
    const root = labels['husk.wslRoot'];
    const tmp = labels['husk.wslTmp'];
    if (root) this.wslPathCache.set(jail.root, root);
    if (tmp) this.wslPathCache.set(jail.tmp, tmp);
  }

  /** Host path -> the same path as WSL sees it. Cached; the round trip costs ~80ms. */
  private wsl(hostPath: string): string {
    const hit = this.wslPathCache.get(hostPath);
    if (hit) return hit;
    const p = wslPath(this.shell.distro as string, hostPath);
    this.wslPathCache.set(hostPath, p);
    return p;
  }

  get id(): string {
    return this.info.id;
  }

  async refresh(): Promise<ComputerInfo> {
    if (this.destroyed || !existsSync(this.jail.root)) this.info.state = 'destroyed';
    return this.info;
  }

  private touch(): void {
    this.info.lastUsedAt = new Date().toISOString();
    void persist(this.info).catch(() => {});
  }

  private assertLive(): void {
    if (this.destroyed || this.info.state === 'destroyed') {
      throw new HuskError('E_COMPUTER_NOT_FOUND', `computer ${this.info.id} has been destroyed`, {
        hint: 'create a new one with `husk up`',
      });
    }
  }

  /**
   * Run a command, surviving one WSL hiccup.
   *
   * WSL dies with "Wsl/Service/E_UNEXPECTED" and recovers a moment later. For an
   * agent running unattended overnight, a single blip must not fail the step --
   * so a spawn failure re-probes the shell and tries once more. The retry is
   * deliberately not a loop: if the second attempt fails too, something is
   * actually wrong and the caller should hear about it.
   */
  async exec(req: ExecRequest): Promise<ExecResult> {
    try {
      return await this.execOnce(req);
    } catch (err) {
      const recoverable =
        this.shell.kind === 'wsl' && err instanceof HuskError && err.code === 'E_EXEC_FAILED';
      if (!recoverable || req.signal?.aborted) throw err;

      this.shell = detectShell(true);
      this.wslPathCache.clear();
      this.mountable = this.shell.kind === 'wsl' && ensureWorkMountpoint(this.shell.distro as string);
      return await this.execOnce(req);
    }
  }

  private async execOnce(req: ExecRequest): Promise<ExecResult> {
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

    const guestCwd = req.cwd ? normaliseGuestPath(req.cwd) : GUEST_ROOT;
    const hostCwd = this.mapPath(req.cwd ?? GUEST_ROOT);
    await mkdir(hostCwd, { recursive: true });

    const { env } = scrubEnv(process.env, { ...this.info.spec.env, ...req.env });
    const script = typeof req.cmd === 'string' ? req.cmd : shellQuote(req.cmd);
    const { file, args, spawnEnv } = this.buildInvocation(script, hostCwd, guestCwd, env);

    const maxBytes = req.maxOutputBytes ?? 256 * 1024;
    const out = new OutputBuffer(maxBytes);
    const err = new OutputBuffer(maxBytes);
    let timedOut = false;

    return await new Promise<ExecResult>((resolvePromise, rejectPromise) => {
      const child = spawn(file, args, {
        cwd: hostCwd,
        env: spawnEnv,
        windowsHide: true,
        // A detached posix child gets its own process group, which is the only
        // reliable way to kill a shell *and* everything it spawned on timeout.
        detached: process.platform !== 'win32',
      });

      const killTree = () => {
        if (child.pid === undefined) return;
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }
      };

      const timeoutSec = req.timeoutSec ?? 120;
      const timer =
        timeoutSec > 0
          ? setTimeout(() => {
              timedOut = true;
              killTree();
            }, timeoutSec * 1000)
          : undefined;

      const onAbort = () => killTree();
      req.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (c: Buffer) => {
        out.push(c);
        req.onStdout?.(c.toString('utf8'));
      });
      child.stderr?.on('data', (c: Buffer) => {
        err.push(c);
        req.onStderr?.(c.toString('utf8'));
      });

      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        rejectPromise(
          new HuskError('E_EXEC_FAILED', `could not start a shell: ${e.message}`, {
            hint:
              this.shell.kind === 'wsl'
                ? 'run `wsl -e true` to check WSL is healthy'
                : 'check that /bin/sh exists and is executable',
            cause: e,
          }),
        );
      });

      // 'close' rather than 'exit', so stdio is flushed first -- otherwise the
      // last chunk of output is lost on fast-exiting commands.
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        this.touch();
        resolvePromise({
          // A killed process reports whatever the wrapper felt like; 124 is what
          // `timeout(1)` uses, and callers key off `timedOut` anyway.
          exitCode: timedOut ? 124 : (code ?? (signal ? 137 : 1)),
          stdout: out.toString(),
          stderr: err.toString(),
          durationMs: Date.now() - started,
          truncated: out.truncated || err.truncated,
          timedOut,
        });
      });

      if (req.stdin !== undefined && child.stdin) child.stdin.end(req.stdin);
      else child.stdin?.end();
    });
  }

  /** Translate one shell script into a concrete (file, argv, env) for this host. */
  private buildInvocation(
    script: string,
    hostCwd: string,
    guestCwd: string,
    env: Record<string, string>,
  ): { file: string; args: string[]; spawnEnv: Record<string, string> } {
    if (this.shell.kind === 'wsl') {
      const distro = this.shell.distro as string;
      // Env goes in as `env K=V` inside the distro rather than through WSLENV,
      // which only forwards variables that already exist on the Windows side and
      // rewrites anything path-shaped while doing it.
      const skip = new Set([
        'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'TMPDIR',
        'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
      ]);
      const assignments = Object.entries(env)
        .filter(([k]) => !skip.has(k.toUpperCase()))
        .map(([k, v]) => `${k}=${shellQuote([v])}`)
        .join(' ');
      const spawnEnv = {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        WINDIR: process.env.WINDIR ?? 'C:\\Windows',
        PATH: process.env.PATH ?? '',
        WSL_UTF8: '1',
      };

      if (this.mountable) {
        const inner =
          `mount --bind ${shellQuote([this.wsl(this.jail.root)])} /work && ` +
          `mount --bind ${shellQuote([this.wsl(this.jail.tmp)])} /tmp && ` +
          `cd ${shellQuote([guestCwd])} && ` +
          `exec env ${assignments} /bin/sh -c ${shellQuote([script])}`;
        return { file: 'wsl.exe', args: ['-d', distro, '-e', 'unshare', '-mr', '/bin/sh', '-c', inner], spawnEnv };
      }

      // No mount point available: run directly in the WSL view of the workspace.
      // `info.workdir` was set to this same path at create time, so the agent is
      // told the truth about where it is rather than being handed a fictional /work.
      const inner = `cd ${shellQuote([this.wsl(hostCwd)])} && exec env ${assignments} /bin/sh -c ${shellQuote([script])}`;
      return { file: 'wsl.exe', args: ['-d', distro, '-e', '/bin/sh', '-c', inner], spawnEnv };
    }

    if (this.shell.kind === 'windows') {
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', script], spawnEnv: env };
    }

    return { file: '/bin/sh', args: ['-c', script], spawnEnv: env };
  }

  /**
   * Guest path -> host path.
   *
   * `/work` and `/tmp` are the canonical form. When the shell could not be given a
   * real `/work`, `info.workdir` is a host- or WSL-shaped path instead, and an agent
   * will echo it back to us -- so those are accepted too, as long as they land inside
   * the jail after resolution.
   */
  private mapPath(path: string): string {
    // A model that asks for `/` means "the top of this machine", and the top of
    // this machine is the workspace. Refusing it teaches the agent nothing.
    if (path === '/' || path === '') return resolve(this.jail.root);
    try {
      return toHostPath(path, this.jail, GUEST_ROOT);
    } catch (err) {
      const direct = this.fromNativePath(path);
      if (direct) return direct;
      throw err;
    }
  }

  /** Accept a host path, or the WSL view of one, when it is inside the jail. */
  private fromNativePath(path: string): string | null {
    const candidates = [path];
    if (this.shell.kind === 'wsl' && path.startsWith('/mnt/')) {
      // /mnt/c/Users/... -> C:\Users\...
      const m = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
      if (m) candidates.push(`${m[1]!.toUpperCase()}:\\${m[2]!.split('/').join('\\')}`);
    }
    for (const c of candidates) {
      const abs = resolve(c);
      for (const base of [this.jail.root, this.jail.tmp]) {
        const b = resolve(base);
        if (abs === b || abs.startsWith(b + sep)) return abs;
      }
    }
    return null;
  }

  private async host(path: string): Promise<string> {
    const h = this.mapPath(path);
    await assertInJail(h, this.jail);
    return h;
  }

  async writeFile(path: string, content: string | Uint8Array, opts: WriteFileOptions = {}): Promise<void> {
    this.assertLive();
    const h = await this.host(path);
    if (opts.mkdirp !== false) await mkdir(dirname(h), { recursive: true });
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    await writeFile(h, data, {
      flag: opts.append ? 'a' : 'w',
      ...(opts.mode ? { mode: parseInt(opts.mode, 8) } : {}),
    });
    this.touch();
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertLive();
    const h = await this.host(path);
    try {
      return await readFile(h);
    } catch (e) {
      throw new HuskError('E_FS_DENIED', `cannot read ${normaliseGuestPath(path, this.info.workdir)}`, {
        hint: 'check the path exists',
        cause: e,
      });
    }
  }

  async readTextFile(path: string, maxBytes = 1024 * 1024): Promise<string> {
    const buf = await this.readFile(path);
    return clampText(Buffer.from(buf).toString('utf8'), maxBytes).text;
  }

  async listDir(path: string): Promise<DirEntry[]> {
    this.assertLive();
    const h = await this.host(path);
    let entries;
    try {
      entries = await readdir(h, { withFileTypes: true });
    } catch (e) {
      throw new HuskError('E_FS_DENIED', `cannot list ${normaliseGuestPath(path, this.info.workdir)}`, {
        hint: 'check the directory exists',
        cause: e,
      });
    }
    const out: DirEntry[] = [];
    for (const e of entries) {
      const child = join(h, e.name);
      let size = 0;
      let modifiedAt: string | undefined;
      try {
        const st = await stat(child);
        size = st.size;
        modifiedAt = st.mtime.toISOString();
      } catch {
        // A file that vanished between readdir and stat is not worth raising.
      }
      out.push({
        name: e.name,
        path: toGuestPath(child, this.jail),
        type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : e.isFile() ? 'file' : 'other',
        size,
        ...(modifiedAt ? { modifiedAt } : {}),
      });
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    this.touch();
    return out;
  }

  async stat(path: string): Promise<DirEntry | null> {
    this.assertLive();
    const h = await this.host(path);
    try {
      const st = await stat(h);
      return {
        name: h.split(/[\\/]/).pop() ?? '',
        path: toGuestPath(h, this.jail),
        type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
      };
    } catch {
      return null;
    }
  }

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    this.assertLive();
    const h = await this.host(path);
    if (resolve(h) === resolve(this.jail.root)) {
      throw new HuskError('E_FS_DENIED', 'refusing to delete the workspace root', {
        hint: 'use `husk rm <computer>` to destroy the whole machine',
      });
    }
    await rm(h, { recursive: opts.recursive ?? false, force: true });
    this.touch();
  }

  async upload(hostPath: string, targetPath: string): Promise<void> {
    this.assertLive();
    const dest = await this.host(targetPath);
    await mkdir(dirname(dest), { recursive: true });
    await cp(hostPath, dest, { recursive: true });
    this.touch();
  }

  async download(path: string, hostPath: string): Promise<void> {
    this.assertLive();
    const src = await this.host(path);
    await mkdir(dirname(hostPath), { recursive: true });
    const st = await stat(src);
    if (st.isDirectory()) await cp(src, hostPath, { recursive: true });
    else await pipeline(createReadStream(src), createWriteStream(hostPath));
    this.touch();
  }

  /**
   * Publish a port the agent is listening on.
   *
   * There is nothing to forward: a `local` process is on the host's own network
   * stack, and WSL2's relay covers the WSL case. But "nothing to forward" was
   * being used to justify handing back a URL nobody had ever connected to,
   * which is a different claim. So it is checked, and the answer is reported.
   *
   * A port that is not up yet is not an error -- exposing before the server has
   * finished binding is the ordinary sequence -- so this reports rather than
   * throws, and gives the listener a moment to appear.
   */
  async exposePort(port: number): Promise<PortBinding> {
    this.assertLive();
    const url = `http://127.0.0.1:${port}`;
    const reachable = await portAnswers(port);
    const binding: PortBinding = { hostPort: port, url, reachable };
    this.info.ports = { ...(this.info.ports ?? {}), [port]: binding };
    await persist(this.info);
    return binding;
  }

  async stop(): Promise<void> {
    this.info.state = 'stopped';
    await persist(this.info);
  }

  async start(): Promise<void> {
    this.assertLive();
    this.info.state = 'running';
    await persist(this.info);
  }

  /**
   * Destroy the machine and free its disk.
   *
   * Every `rm` here used to be `.catch(() => {})`, which made the common failure
   * invisible: a process the agent left running -- a provisioned Chromium is
   * 325 MB of it -- still holds files open, Windows refuses the delete, and the
   * registry entry gets removed anyway. The computer disappears from `husk ps`
   * while its workspace stays on disk forever. I found 1.9 GB of those.
   *
   * So: retry, because the lock is usually a process on its way out; and when
   * it still will not go, keep the registry entry and say so. A leaked
   * workspace that is still listed can be cleaned up. One that is not is lost.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    const workspace = this.info.spec.labels?.['husk.workspace'];

    // An in-distro workspace is deleted from inside it. Removing 325 MB of
    // unpacked Chromium one file at a time over the \wsl.localhost share takes
    // minutes and trips over Linux filenames Windows will not open; `rm -rf`
    // in the distro is one call and knows the filesystem it is on.
    const linuxWorkspace = this.info.spec.labels?.['husk.wslWorkspace'];
    const distro = this.info.spec.labels?.['husk.shell']?.replace(/^wsl:/, '');
    if (linuxWorkspace && distro) {
      const done = spawnSync('wsl.exe', ['-d', distro, '-e', 'rm', '-rf', linuxWorkspace], {
        timeout: 120_000,
        windowsHide: true,
      });
      if (done.status === 0) {
        this.destroyed = true;
        this.info.state = 'destroyed';
        await rm(join(paths().computers, `${this.info.id}.json`), { force: true }).catch(() => {});
        return;
      }
      // Fell through on purpose: if WSL is unwell the host still sees the same
      // files through the UNC path, and a slow delete beats a leaked 325 MB.
    }

    const targets = [this.jail.root, this.jail.tmp, ...(workspace ? [workspace] : [])];

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      lastErr = undefined;
      for (const dir of targets) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (err) {
          lastErr = err;
        }
      }
      if (!lastErr) break;
      // A file handle being released is a race, not a permanent state.
      await new Promise((r) => setTimeout(r, attempt * 250));
    }

    if (lastErr) {
      this.info.state = 'error';
      this.info.error = `workspace could not be removed: ${(lastErr as Error).message}`;
      await persist(this.info);
      throw new HuskError('E_COMPUTER_FAILED', `destroyed ${this.info.id}, but its files are still on disk`, {
        hint: 'something inside it still holds a file open -- close it and run `husk rm` again',
        details: { workspace: workspace ?? this.jail.root },
        cause: lastErr,
      });
    }

    this.destroyed = true;
    this.info.state = 'destroyed';
    await rm(join(paths().computers, `${this.info.id}.json`), { force: true }).catch(() => {});
  }
}

/**
 * Workspace directories with no registry entry behind them.
 *
 * These are the ones a failed destroy left behind before it learned to report
 * itself. Returned rather than deleted: reclaiming disk is the caller's call.
 */
export async function findOrphanedWorkspaces(): Promise<string[]> {
  const p = ensurePaths();
  const infos = await loadInfos();
  const known = new Set(
    infos.map((i: ComputerInfo) => i.spec.labels?.['husk.workspace'] ?? join(p.workspaces, i.id)),
  );

  const orphans: string[] = [];

  // The Windows-side directory. Still used by the posix and host-shell cases,
  // and by every WSL computer created before workspaces moved into the distro.
  try {
    for (const dir of await readdir(p.workspaces)) {
      if (!dir.startsWith('cmp_')) continue;
      const full = join(p.workspaces, dir);
      if (!known.has(full)) orphans.push(full);
    }
  } catch {
    // No workspaces directory yet is not a problem to report.
  }

  // And inside each distro husk has actually used. Skipped entirely when none
  // has been -- a `doctor` run on a machine with no WSL should not pay for a
  // `wsl.exe` probe, and on a broken WSL it should not hang on one either.
  const knownLinux = new Set(
    infos.map((i: ComputerInfo) => i.spec.labels?.['husk.wslWorkspace']).filter((x): x is string => Boolean(x)),
  );
  for (const distro of distrosInUse(infos)) {
    const listed = spawnSync(
      'wsl.exe',
      ['-d', distro, '-e', 'sh', '-c', 'ls -1d "$HOME"/.husk/workspaces/cmp_* 2>/dev/null || true'],
      { timeout: 15_000, windowsHide: true },
    );
    if (listed.status !== 0) continue;
    for (const line of (listed.stdout?.toString('utf8') ?? '').replace(/\0/g, '').split(/\r?\n/)) {
      const dir = line.trim();
      if (dir && !knownLinux.has(dir)) orphans.push(`${distro}:${dir}`);
    }
  }

  return orphans;
}

/**
 * The distros this husk home has a computer in, and no others.
 *
 * Deliberately derived from the registry rather than from `detectShell`. A
 * distro's workspaces live under its own `$HOME/.husk`, which has nothing to do
 * with `HUSK_HOME` on the Windows side -- so probing the current distro
 * unconditionally made an isolated husk home report another one's workspaces as
 * its orphans, and made `doctor` pay for a `wsl.exe` round trip it had no use
 * for. Both observed: a temp-home test found two live workspaces, and the probe
 * cost 14 seconds.
 *
 * The cost is that orphans in a distro with no surviving registry entry go
 * unseen. That is the rarer case -- an orphan is a workspace whose *deletion*
 * failed, and the entry is normally still there -- and it is better than
 * answering for a home that did not ask.
 */
function distrosInUse(infos: ComputerInfo[]): string[] {
  const names = new Set<string>();
  for (const i of infos) {
    const shell = i.spec.labels?.['husk.shell'];
    if (shell?.startsWith('wsl:')) names.add(shell.slice(4));
  }
  return [...names];
}

function splitList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v.split('\u0000').filter(Boolean);
}

function jailFor(workspaceRoot: string): JailMap {
  return { root: join(workspaceRoot, 'root'), tmp: join(workspaceRoot, 'tmp') };
}

export class LocalProvider implements ComputerProvider {
  readonly name: ProviderName = 'local';
  readonly description = 'A guarded working directory on this machine. Free, always available, not isolated.';
  readonly priority = 10;

  async isAvailable(): Promise<Availability> {
    const shell = detectShell();
    return {
      available: true,
      isolated: false,
        isolationKind: 'guardrails',
      version: shell.label,
      reason:
        shell.kind === 'windows'
          ? 'guarded working directory -- and with no WSL, commands run in the Windows shell, not Linux'
          : 'guarded working directory -- process guardrails, not a sandbox',
      hint:
        shell.kind === 'windows'
          ? 'run `wsl --install` for a real Linux shell, or start Docker for actual isolation'
          : 'start Docker for kernel-level isolation',
    };
  }

  async create(spec: ComputerSpec): Promise<Computer> {
    const p = ensurePaths();
    const id = newId('cmp');

    // A WSL computer keeps its files inside the distro; everything else keeps
    // them under ~/.husk/workspaces as before. `inDistro` is null when that
    // could not be arranged, and the Windows-side layout is the fallback.
    const probe = detectShell();
    const inDistro = probe.kind === 'wsl' ? distroWorkspace(probe.distro as string, id) : null;

    const workspaceRoot = inDistro ? inDistro.host : join(p.workspaces, id);
    const jail = jailFor(workspaceRoot);

    await mkdir(jail.root, { recursive: true, mode: 0o700 });
    await mkdir(jail.tmp, { recursive: true, mode: 0o700 });

    // When we cannot present a real /work inside the shell, say where the agent
    // actually is. A fictional workdir is worse than an ugly one.
    //
    // WSL can also die between the probe and here, so a failure to map the path
    // degrades to the host shell rather than taking the whole create down with it.
    let shell = detectShell();
    let mountable = shell.kind === 'wsl' && ensureWorkMountpoint(shell.distro as string);
    let workdir = spec.workdir;
    const wslLabels: Record<string, string> = {};

    if (shell.kind === 'wsl') {
      // Resolve both mount sources now. Doing it here means a later `exec` is
      // pure spawn with no wsl.exe round trip, and a WSL that is unwell fails
      // once at create -- where we can still degrade -- instead of failing
      // halfway through an agent's run.
      try {
        // Already known when the workspace is in the distro -- no conversion,
        // and no second wsl.exe round trip to get back what we just made.
        wslLabels['husk.wslRoot'] = inDistro ? `${inDistro.linux}/root` : wslPath(shell.distro as string, jail.root);
        wslLabels['husk.wslTmp'] = inDistro ? `${inDistro.linux}/tmp` : wslPath(shell.distro as string, jail.tmp);
        if (inDistro) wslLabels['husk.wslWorkspace'] = inDistro.linux;
        workdir ??= mountable ? GUEST_ROOT : wslLabels['husk.wslRoot'];
      } catch (err) {
        shell = downgradeFromWsl((err as Error).message);
        mountable = false;
        delete wslLabels['husk.wslRoot'];
        delete wslLabels['husk.wslTmp'];
        workdir ??= jail.root;
      }
    } else {
      workdir ??= shell.kind === 'windows' ? jail.root : GUEST_ROOT;
    }

    const now = new Date().toISOString();
    const info: ComputerInfo = {
      id,
      name: spec.name ?? id,
      provider: 'local',
      state: 'running',
      image: `local:${shell.kind}`,
      workdir,
      createdAt: now,
      lastUsedAt: now,
      nativeId: workspaceRoot,
      spec: {
        ...spec,
        provider: 'local',
        labels: {
          ...(spec.labels ?? {}),
          ...wslLabels,
          'husk.shell': shell.kind === 'wsl' ? `wsl:${shell.distro}` : shell.kind,
          'husk.workspace': workspaceRoot,
        },
      },
    };

    await persist(info);
    const computer = new LocalComputer(info, jail, shell);
    if (spec.setup || (spec.packages?.length ?? 0) > 0) await this.runSetup(computer, spec);
    return computer;
  }

  /**
   * Best-effort provisioning. A failed setup leaves a usable machine and a log,
   * because an agent can often do its job without the extra packages -- and when
   * it cannot, reading the log beats a machine that never came up.
   */
  private async runSetup(computer: Computer, spec: ComputerSpec): Promise<void> {
    const lines: string[] = [];
    if (spec.packages?.length) {
      const pkgs = shellQuote(spec.packages);
      lines.push(
        `command -v uv >/dev/null 2>&1 && uv pip install --system ${pkgs} 2>/dev/null || ` +
          `pip install ${pkgs} 2>/dev/null || npm i -g ${pkgs} 2>/dev/null || ` +
          `echo "husk: could not install: ${spec.packages.join(' ')}" >&2`,
      );
    }
    if (spec.setup) lines.push(spec.setup);
    await computer.writeFile(`${GUEST_TMP}/husk-setup.sh`, lines.join('\n') + '\n');
    const r = await computer.exec({ cmd: `sh ${GUEST_TMP}/husk-setup.sh`, timeoutSec: 300 });
    if (r.exitCode !== 0) {
      await computer.writeFile(`${GUEST_TMP}/husk-setup.log`, `${r.stdout}\n${r.stderr}`);
    }
  }

  async get(id: string): Promise<Computer | null> {
    const all = await loadInfos('local');
    const info = all.find((i) => i.id === id || i.name === id);
    if (!info || info.provider !== 'local') return null;
    const workspaceRoot = info.spec.labels?.['husk.workspace'] ?? join(paths().workspaces, info.id);
    if (!existsSync(workspaceRoot)) return null;
    return new LocalComputer(info, jailFor(workspaceRoot), detectShell());
  }

  async list(): Promise<ComputerInfo[]> {
    return (await loadInfos('local')).filter((i) => i.state !== 'destroyed');
  }

  async reap(): Promise<string[]> {
    const removed: string[] = [];
    const now = Date.now();
    for (const info of await this.list()) {
      const idle = info.spec.idleTimeoutSec ?? 0;
      const life = info.spec.maxLifetimeSec ?? 0;
      const idleFor = (now - new Date(info.lastUsedAt).getTime()) / 1000;
      const aliveFor = (now - new Date(info.createdAt).getTime()) / 1000;
      if ((idle > 0 && idleFor > idle) || (life > 0 && aliveFor > life)) {
        const c = await this.get(info.id);
        if (c) {
          await c.destroy();
          removed.push(info.id);
        }
      }
    }
    return removed;
  }
}

/**
 * Can anything be connected to on this port?
 *
 * A bare TCP connect, not an HTTP request: the agent may have started something
 * that does not speak HTTP, and the question here is only whether the port is
 * live. Retried briefly, because a server that is still binding is the common
 * case rather than a failure.
 */
export async function portAnswers(port: number, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' });
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(400, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    if (open) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
