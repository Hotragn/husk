import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, connect as tcpConnect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HuskError, ensurePaths, id as newId } from '@husk/core';
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
import { type ImagePlan, resolveImage } from '../images.js';
import { OutputBuffer, evaluateCommand } from '../policy.js';

/**
 * Everything Docker and Podman have in common, which is very nearly everything.
 *
 * Both speak the same container CLI: `run`, `exec`, `cp`, `inspect`, `commit`.
 * The differences that matter -- how you detect the engine, whether it is
 * rootless, what to tell a user when it is missing -- live in the two thin
 * subclasses. The argv builders below are pure so the flags that make the
 * difference between "a container" and the isolation docs/SECURITY-MODEL.md
 * promises can be asserted exactly, without either engine installed.
 */

const execFileAsync = promisify(execFile);

export interface OciConfig {
  /** The CLI to shell out to: `docker` or `podman`. */
  binary: string;
  /** Value written to the `husk.provider` label, and reported on every ComputerInfo. */
  provider: ProviderName;
  /**
   * True when the engine runs containers in a user namespace owned by the
   * invoking user. Only affects what we can honestly claim about networking.
   */
  rootless: boolean;
}

/** Container paths are always POSIX, whatever the host's separator is. */
export function posixDirname(p: string): string {
  const norm = p.split('\\').join('/');
  const i = norm.lastIndexOf('/');
  return i <= 0 ? '/' : norm.slice(0, i);
}

export function encodeSpec(spec: ComputerSpec): string {
  return Buffer.from(JSON.stringify(spec)).toString('base64');
}

export function decodeSpec(label: string | undefined): ComputerSpec {
  if (!label) return {};
  try {
    return JSON.parse(Buffer.from(label, 'base64').toString('utf8')) as ComputerSpec;
  } catch {
    return {};
  }
}

export interface OciRunPlan {
  /** The husk id, used for the container name and the `husk.id` label. */
  cid: string;
  image: string;
  workdir: string;
  spec: ComputerSpec;
}

/**
 * Build the argv for `run`.
 *
 * The hardening block is unconditional on purpose: none of it is a knob the
 * caller can turn off, because every one of these flags is load-bearing for the
 * isolation claim the provider makes in `husk doctor`.
 */
export function buildRunArgs(cfg: OciConfig, plan: OciRunPlan): string[] {
  const { cid, image, workdir, spec } = plan;
  const args = ['run', '-d', '--name', spec.name ?? cid];

  args.push('--label', `husk.provider=${cfg.provider}`);
  args.push('--label', `husk.spec=${encodeSpec(spec)}`);
  args.push('--label', `husk.id=${cid}`);

  args.push('--cap-drop', 'ALL');
  args.push('--security-opt', 'no-new-privileges');
  // A fork bomb inside the machine should hit its own ceiling, not the host's.
  args.push('--pids-limit', '512');
  // Read-only root, writable only where work happens: anything written elsewhere
  // fails loudly instead of mutating an image layer that is about to vanish.
  args.push('--read-only');
  args.push('--tmpfs', '/tmp:rw,exec,nosuid,size=512m');
  args.push('--tmpfs', '/run:rw,nosuid,size=16m');
  if (spec.persist) {
    args.push('-v', `husk-${cid}:${workdir}`);
  } else {
    args.push('--tmpfs', `${workdir}:rw,exec,nosuid,size=${spec.diskMb ?? 2048}m`);
  }

  args.push(`--cpus=${spec.cpus ?? 2}`);
  args.push(`--memory=${spec.memoryMb ?? 2048}m`);
  // Without this the memory limit only delays the OOM -- the container swaps first.
  args.push(`--memory-swap=${spec.memoryMb ?? 2048}m`);

  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`);
  }

  if (spec.mounts) {
    for (const m of spec.mounts) {
      // Read-only unless explicitly opted out. A host mount is the one hole in the
      // container, and an agent that only needs to read a repo must not rewrite it.
      args.push('-v', `${resolve(m.source)}:${m.target}${m.readonly === false ? '' : ':ro'}`);
    }
  }

  args.push('-w', workdir);
  // Never root. Our images ship a `husk` user at uid 1000; upstream fallbacks may
  // not, but 1000:1000 is unprivileged on all of them.
  args.push('-u', spec.user ?? '1000:1000');

  if (spec.labels) {
    for (const [k, v] of Object.entries(spec.labels)) args.push('--label', `${k}=${v}`);
  }

  // `egress` is enforced at the tool layer, not here: neither engine can
  // allow-list hostnames, and implying it did would be the dangerous kind of vague.
  if (spec.network?.mode === 'none') args.push('--network=none');

  args.push(image, 'sleep', 'infinity');
  return args;
}

/** A shell string becomes `/bin/sh -c`; an argv array is executed directly. */
export function toContainerArgv(cmd: string | string[]): string[] {
  if (typeof cmd === 'string') return ['/bin/sh', '-c', cmd];
  if (cmd.length === 0) {
    throw new HuskError('E_EXEC_FAILED', 'empty command array', {
      hint: 'pass a shell string, or an argv array whose first element is the program',
    });
  }
  return [...cmd];
}

export interface OciExecPlan {
  containerId: string;
  cmd: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
  tty?: boolean;
}

export function buildExecArgs(_cfg: OciConfig, plan: OciExecPlan): string[] {
  const args = ['exec', '-i'];
  // A pty is what makes `isatty` true, which is what makes half of CLI tooling
  // print progress instead of nothing. It is never the default: with a tty the
  // engine merges stderr into stdout and we lose the split.
  if (plan.tty) args.push('-t');
  if (plan.cwd) args.push('-w', plan.cwd);
  if (plan.env) {
    for (const [k, v] of Object.entries(plan.env)) args.push('-e', `${k}=${v}`);
  }
  if (plan.user) args.push('-u', plan.user);
  args.push(plan.containerId, ...toContainerArgv(plan.cmd));
  return args;
}

export function buildCopyIntoArgs(containerId: string, hostPath: string, targetPath: string): string[] {
  return ['cp', hostPath, `${containerId}:${targetPath}`];
}

export function buildCopyOutOfArgs(containerId: string, path: string, hostPath: string): string[] {
  return ['cp', `${containerId}:${path}`, hostPath];
}

/**
 * Parse one `ls -lA` listing.
 *
 * Shared with the ssh provider, which faces the same problem: the only listing
 * tool guaranteed to exist on an arbitrary Linux userland is `ls`.
 */
export function parseLsLong(stdout: string, dir: string): DirEntry[] {
  const base = dir.replace(/\/+$/, '');
  const out: DirEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim() || line.startsWith('total')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    let name = parts.slice(8).join(' ');
    const typeChar = line[0];
    // `ls -l` renders a symlink as "link -> target"; the name is the left half.
    if (typeChar === 'l') name = name.split(' -> ')[0] ?? name;
    if (!name || name === '.' || name === '..') continue;
    out.push({
      name,
      path: `${base}/${name}`,
      type: typeChar === 'd' ? 'dir' : typeChar === 'l' ? 'symlink' : typeChar === '-' ? 'file' : 'other',
      size: Number.parseInt(parts[4] ?? '0', 10) || 0,
    });
  }
  return out;
}

/** Snapshot bookkeeping lives next to the tarball it describes. */
interface SnapshotRecord {
  id: string;
  provider: ProviderName;
  image: string;
  /** Tarball of the workdir, which a committed image layer never contains. */
  workTar: string;
  workdir: string;
  createdAt: string;
}

function snapshotDir(): string {
  return join(ensurePaths().cache, 'snapshots');
}

export class OciComputer implements Computer {
  readonly info: ComputerInfo;
  protected readonly cfg: OciConfig;
  /** Set by the provider so `restore` can rebuild the container from a new image. */
  private readonly recreate?: (image: string, info: ComputerInfo) => Promise<string>;
  private readonly forwarders = new Map<number, PortBinding>();
  private readonly servers = new Map<number, Server>();
  private readonly liveSockets = new Set<Socket>();

  constructor(
    cfg: OciConfig,
    info: ComputerInfo,
    recreate?: (image: string, info: ComputerInfo) => Promise<string>,
  ) {
    this.cfg = cfg;
    this.info = info;
    this.recreate = recreate;
  }

  get id(): string {
    return this.info.id;
  }

  private get native(): string {
    const n = this.info.nativeId;
    if (!n) {
      throw new HuskError('E_COMPUTER_NOT_FOUND', `computer ${this.info.id} has no container behind it`, {
        hint: 'create a new one with `husk up`',
      });
    }
    return n;
  }

  private cli(args: string[], timeoutMs = 60_000) {
    return execFileAsync(this.cfg.binary, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  }

  async refresh(): Promise<ComputerInfo> {
    try {
      const { stdout } = await this.cli(['inspect', this.native]);
      const data = JSON.parse(stdout)[0];
      if (data) this.info.state = readState(data);
    } catch {
      this.info.state = 'destroyed';
    }
    return this.info;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    // Same policy as the local provider. A container limits the blast radius of a
    // destructive command; it does not make running one a good idea.
    const labels = this.info.spec.labels ?? {};
    const decision = evaluateCommand(req.cmd, {
      deny: splitList(labels['husk.denyCommands']),
      allow: splitList(labels['husk.allowCommands']),
    });
    if (!decision.allowed) {
      throw new HuskError('E_EXEC_DENIED', `refused: ${decision.reason}`, {
        hint: 'add a pattern to guardrails.allowCommands in husk.yaml if this is intentional',
        details: { rule: decision.rule },
      });
    }

    const args = buildExecArgs(this.cfg, {
      containerId: this.native,
      cmd: req.cmd,
      ...(req.cwd ? { cwd: req.cwd } : {}),
      ...(req.env ? { env: req.env } : {}),
      ...(req.user ? { user: req.user } : {}),
      ...(req.tty ? { tty: true } : {}),
    });

    const started = Date.now();
    const maxBytes = req.maxOutputBytes ?? 256 * 1024;
    const out = new OutputBuffer(maxBytes);
    const err = new OutputBuffer(maxBytes);

    return await new Promise<ExecResult>((settle) => {
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let done = false;

      const child = spawn(this.cfg.binary, args, { windowsHide: true });

      const finish = (result: ExecResult) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        this.info.lastUsedAt = new Date().toISOString();
        settle(result);
      };

      const kill = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };

      function onAbort() {
        timedOut = true;
        kill();
      }

      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener('abort', onAbort, { once: true });

      if (req.timeoutSec && req.timeoutSec > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, req.timeoutSec * 1000);
      }

      child.stdout?.on('data', (c: Buffer) => {
        out.push(c);
        req.onStdout?.(c.toString('utf8'));
      });
      child.stderr?.on('data', (c: Buffer) => {
        err.push(c);
        req.onStderr?.(c.toString('utf8'));
      });

      // An EPIPE on stdin (the container exited first) must not become an
      // unhandled 'error' event that takes the process down.
      child.stdin?.on('error', () => {});

      child.on('error', (e) => {
        finish({
          exitCode: 1,
          stdout: out.toString(),
          stderr: err.toString() + `\n${this.cfg.binary}: ${e.message}`,
          durationMs: Date.now() - started,
          truncated: out.truncated || err.truncated,
          timedOut,
        });
      });

      // 'close' rather than 'exit', so stdio is flushed first -- otherwise the
      // last chunk of output is lost on fast-exiting commands.
      child.on('close', (code, signal) => {
        finish({
          // 124 is what `timeout(1)` uses; callers key off `timedOut` anyway.
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

  async writeFile(path: string, content: string | Uint8Array, opts?: WriteFileOptions): Promise<void> {
    if (opts?.append) {
      // `cp` replaces; appending has to go through the shell.
      const b64 = Buffer.from(typeof content === 'string' ? Buffer.from(content, 'utf8') : content).toString('base64');
      const r = await this.exec({
        cmd: `mkdir -p '${posixDirname(path)}' && printf %s '${b64}' | base64 -d >> '${path}'`,
      });
      if (r.exitCode !== 0) {
        throw new HuskError('E_FS_DENIED', `cannot append to ${path}: ${r.stderr.trim()}`, {
          hint: 'check the path is under a writable mount (/work or /tmp)',
        });
      }
      return;
    }

    const tmpPath = join(tmpdir(), newId(`husk-${this.cfg.provider}`));
    await writeFile(tmpPath, typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content));
    try {
      if (opts?.mkdirp !== false) {
        await this.cli(['exec', this.native, 'mkdir', '-p', posixDirname(path)]);
      }
      await this.cli(buildCopyIntoArgs(this.native, tmpPath, path));
      if (opts?.mode) {
        await this.cli(['exec', this.native, 'chmod', opts.mode, path]);
      }
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const tmpPath = join(tmpdir(), newId(`husk-${this.cfg.provider}`));
    try {
      await this.cli(buildCopyOutOfArgs(this.native, path, tmpPath));
      return new Uint8Array(await readFile(tmpPath));
    } catch (e) {
      throw new HuskError('E_FS_DENIED', `cannot read ${path}`, {
        hint: 'check the path exists inside the computer',
        cause: e,
      });
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  async readTextFile(path: string, maxBytes?: number): Promise<string> {
    const buf = await this.readFile(path);
    const text = new TextDecoder().decode(buf);
    return maxBytes && text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  async listDir(path: string): Promise<DirEntry[]> {
    try {
      const { stdout } = await this.cli(['exec', this.native, 'ls', '-lA', path]);
      return parseLsLong(stdout, path);
    } catch {
      return [];
    }
  }

  async stat(path: string): Promise<DirEntry | null> {
    try {
      const { stdout } = await this.cli(['exec', this.native, 'stat', '-c', '%s %F', path]);
      const [sizeStr, ...typeParts] = stdout.trim().split(' ');
      const typeStr = typeParts.join(' ');
      return {
        name: path.split('/').pop() || '',
        path,
        type: typeStr.includes('directory') ? 'dir' : typeStr.includes('symbolic') ? 'symlink' : 'file',
        size: Number.parseInt(sizeStr ?? '0', 10) || 0,
      };
    } catch {
      return null;
    }
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.cli(['exec', this.native, 'rm', opts?.recursive ? '-rf' : '-f', path]);
  }

  async upload(hostPath: string, targetPath: string): Promise<void> {
    await this.cli(buildCopyIntoArgs(this.native, hostPath, targetPath), 300_000);
  }

  async download(path: string, hostPath: string): Promise<void> {
    await this.cli(buildCopyOutOfArgs(this.native, path, hostPath), 300_000);
  }

  async exposePort(port: number): Promise<PortBinding> {
    const existing = this.forwarders.get(port);
    if (existing) return existing;

    // Neither engine can publish a port on an already-running container, and an
    // agent only knows it needs one after it has started a server. So we forward
    // in userspace: a host listener piping to the container's IP. Costs one socket
    // pair per connection and needs no daemon cooperation.
    const containerIp = await this.containerIp();
    await this.assertRoutable(containerIp, port);

    const server = createServer((client: Socket) => {
      const upstream = tcpConnect(port, containerIp);
      this.liveSockets.add(client).add(upstream);
      // Either side erroring must tear down both, or sockets leak on every refusal.
      const bail = () => {
        this.liveSockets.delete(client);
        this.liveSockets.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', bail);
      upstream.on('error', bail);
      client.on('close', bail);
      upstream.on('close', bail);
      client.pipe(upstream);
      upstream.pipe(client);
    });

    const hostPort = await new Promise<number>((res, rej) => {
      server.once('error', rej);
      // Port 0 lets the OS pick a free one, so two computers exposing 8000 do not collide.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') res(addr.port);
        else rej(new Error('could not determine the forwarded port'));
      });
    });
    server.unref();

    const binding: PortBinding = { hostPort, url: `http://127.0.0.1:${hostPort}` };
    this.forwarders.set(port, binding);
    this.servers.set(port, server);
    this.info.ports = { ...(this.info.ports ?? {}), [port]: binding };
    return binding;
  }

  private async containerIp(): Promise<string> {
    const { stdout } = await this.cli([
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      this.native,
    ]);
    const ip = stdout.trim();
    if (!ip) {
      throw new HuskError('E_COMPUTER_FAILED', 'the container has no reachable IP address', {
        hint: 'a computer created with network.mode "none" cannot expose a port',
      });
    }
    return ip;
  }

  /**
   * Refuse to hand back a URL that cannot work.
   *
   * A container IP is only routable from the host when the engine puts the
   * container on a host-visible bridge. Rootless Podman (slirp4netns/pasta) and
   * Docker Desktop's VM both fail that test, and returning a forwarder for them
   * would produce a port that accepts connections and then hangs. A refused
   * connection is fine -- it proves the route works and nothing is listening yet.
   */
  private async assertRoutable(ip: string, port: number): Promise<void> {
    const code = await new Promise<string | null>((res) => {
      const probe = tcpConnect({ host: ip, port, timeout: 1500 });
      const done = (v: string | null) => {
        probe.removeAllListeners();
        probe.destroy();
        res(v);
      };
      probe.on('connect', () => done(null));
      probe.on('timeout', () => done('ETIMEDOUT'));
      probe.on('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'EUNKNOWN'));
    });
    if (code === null || code === 'ECONNREFUSED') return;
    throw new HuskError('E_COMPUTER_FAILED', `the container network at ${ip} is not reachable from this host (${code})`, {
      hint: this.cfg.rootless
        ? 'rootless containers route through a user-mode network stack; publish the port at create time or use --provider docker'
        : 'on Docker Desktop the container network lives inside a VM; run the engine natively, or reach the service from another container',
      details: { ip, port, provider: this.cfg.provider },
    });
  }

  async stop(): Promise<void> {
    await this.cli(['stop', this.native], 120_000);
    this.info.state = 'stopped';
  }

  async start(): Promise<void> {
    await this.cli(['start', this.native]);
    this.info.state = 'running';
  }

  async destroy(): Promise<void> {
    this.closeForwarders();
    await this.cli(['rm', '-f', this.native], 120_000).catch(() => {});
    this.info.state = 'destroyed';
  }

  private closeForwarders(): void {
    for (const s of this.liveSockets) s.destroy();
    this.liveSockets.clear();
    for (const server of this.servers.values()) server.close();
    this.servers.clear();
    this.forwarders.clear();
  }

  /**
   * Commit the image layer *and* tar the workdir.
   *
   * `commit` alone would be a lie for the default machine: `/work` is a tmpfs, so
   * nothing an agent actually did would be in the snapshot.
   */
  async snapshot(name?: string): Promise<{ id: string; sizeBytes?: number }> {
    const snapId = name ? `husk-${name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}` : newId('snap');
    const tag = `husk-snapshot:${snapId}`;
    await this.cli(['commit', this.native, tag], 300_000);

    const dir = snapshotDir();
    await mkdir(dir, { recursive: true });
    const workTar = join(dir, `${snapId}.tar`);
    await this.tarOut(this.info.workdir, workTar);

    const record: SnapshotRecord = {
      id: snapId,
      provider: this.cfg.provider,
      image: tag,
      workTar,
      workdir: this.info.workdir,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, `${snapId}.json`), JSON.stringify(record, null, 2), 'utf8');

    let sizeBytes: number | undefined;
    try {
      const [{ stdout }, tarStat] = await Promise.all([
        this.cli(['image', 'inspect', '-f', '{{.Size}}', tag]),
        stat(workTar),
      ]);
      sizeBytes = (Number.parseInt(stdout.trim(), 10) || 0) + tarStat.size;
    } catch {
      // A missing size is not worth failing a successful snapshot over.
    }
    return { id: snapId, ...(sizeBytes !== undefined ? { sizeBytes } : {}) };
  }

  async restore(snapshotId: string): Promise<void> {
    if (!this.recreate) {
      throw new HuskError('E_NOT_IMPLEMENTED', 'this computer was not created by a provider that can rebuild it', {
        hint: 'restore from `husk up --snapshot <id>` instead',
      });
    }
    const dir = snapshotDir();
    let record: SnapshotRecord;
    try {
      record = JSON.parse(await readFile(join(dir, `${snapshotId}.json`), 'utf8')) as SnapshotRecord;
    } catch (e) {
      throw new HuskError('E_COMPUTER_NOT_FOUND', `no snapshot named ${snapshotId}`, {
        hint: 'list what is there with `ls ~/.husk/cache/snapshots`',
        cause: e,
      });
    }

    this.closeForwarders();
    await this.cli(['rm', '-f', this.native], 120_000).catch(() => {});
    const nativeId = await this.recreate(record.image, this.info);
    this.info.nativeId = nativeId;
    this.info.image = record.image;
    this.info.state = 'running';
    await this.tarIn(record.workTar, this.info.workdir);
  }

  /** Stream a directory out of the container as a tar, without buffering it in RAM. */
  private tarOut(dir: string, hostFile: string): Promise<void> {
    return new Promise((res, rej) => {
      const child = spawn(this.cfg.binary, ['exec', this.native, 'tar', '-cf', '-', '-C', dir, '.'], {
        windowsHide: true,
      });
      const sink = createWriteStream(hostFile);
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      child.stdout.pipe(sink);
      child.on('error', rej);
      sink.on('error', rej);
      child.on('close', (code) => {
        sink.end();
        if (code === 0) res();
        else rej(new HuskError('E_COMPUTER_FAILED', `could not archive ${dir}: ${stderr.trim()}`));
      });
    });
  }

  private tarIn(hostFile: string, dir: string): Promise<void> {
    return new Promise((res, rej) => {
      const child = spawn(this.cfg.binary, ['exec', '-i', this.native, 'tar', '-xf', '-', '-C', dir], {
        windowsHide: true,
      });
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      child.stdin?.on('error', () => {});
      child.on('error', rej);
      child.on('close', (code) =>
        code === 0 ? res() : rej(new HuskError('E_COMPUTER_FAILED', `could not restore ${dir}: ${stderr.trim()}`)),
      );
      createReadStream(hostFile).pipe(child.stdin);
    });
  }
}

function splitList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v.split('\u0000').filter(Boolean);
}

function readState(data: { State?: { Running?: boolean; Status?: string } }): ComputerInfo['state'] {
  if (data.State?.Running) return 'running';
  const status = data.State?.Status;
  if (status === 'exited' || status === 'stopped' || status === 'created') return 'stopped';
  if (status === 'paused') return 'paused';
  return 'error';
}

/**
 * The half of a container provider that does not care which engine it is.
 *
 * Subclasses supply identity (`name`, `description`, `priority`) and the one
 * genuinely engine-specific thing: how to tell a user why it is not working.
 */
export abstract class OciProvider implements ComputerProvider {
  abstract readonly name: ProviderName;
  abstract readonly description: string;
  abstract readonly priority: number;
  abstract isAvailable(): Promise<Availability>;

  protected readonly cfg: OciConfig;

  constructor(cfg: OciConfig) {
    this.cfg = cfg;
  }

  protected cli(args: string[], timeoutMs = 60_000) {
    return execFileAsync(this.cfg.binary, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  }

  /**
   * Prefer our image, fall back to the public one.
   *
   * Nobody has pulled `ghcr.io/husk-sh/*` on a fresh install, and a first run that
   * dies on a registry 404 is a first run that does not happen twice.
   */
  protected async pullable(plan: ImagePlan): Promise<string> {
    for (const candidate of [plan.primary, plan.fallback]) {
      try {
        await this.cli(['image', 'inspect', candidate], 15_000);
        return candidate;
      } catch {
        // not local
      }
      try {
        await this.cli(['pull', '--quiet', candidate], 300_000);
        return candidate;
      } catch {
        // try the next one
      }
    }
    throw new HuskError('E_COMPUTER_FAILED', `could not obtain an image (tried ${plan.primary}, ${plan.fallback})`, {
      hint: 'check network access to the registry, or set computer.image to something already pulled',
    });
  }

  async create(spec: ComputerSpec): Promise<Computer> {
    const cid = newId('cmp');
    const plan = resolveImage(spec);
    const image = await this.pullable(plan);
    const workdir = spec.workdir ?? '/work';
    const runArgs = buildRunArgs(this.cfg, { cid, image, workdir, spec });

    let nativeId: string;
    try {
      const { stdout } = await this.cli(runArgs, 180_000);
      nativeId = stdout.trim();
    } catch (e) {
      throw new HuskError('E_COMPUTER_FAILED', `could not start a ${this.cfg.binary} container: ${(e as Error).message}`, {
        hint: `run \`${this.cfg.binary} info\` to check the engine is healthy`,
        cause: e,
      });
    }

    const now = new Date().toISOString();
    const info: ComputerInfo = {
      id: cid,
      name: spec.name ?? cid,
      provider: this.cfg.provider,
      state: 'running',
      image,
      workdir,
      createdAt: now,
      lastUsedAt: now,
      spec,
      nativeId,
    };

    const comp = this.wrap(info);
    if (spec.setup) await comp.exec({ cmd: spec.setup, timeoutSec: 300 });
    return comp;
  }

  protected wrap(info: ComputerInfo): OciComputer {
    return new OciComputer(this.cfg, info, (image, current) => this.recreate(image, current));
  }

  /** Rebuild a container for the same husk id on a different image. Used by restore. */
  private async recreate(image: string, info: ComputerInfo): Promise<string> {
    const args = buildRunArgs(this.cfg, {
      cid: info.id,
      image,
      workdir: info.workdir,
      spec: info.spec,
    });
    const { stdout } = await this.cli(args, 180_000);
    return stdout.trim();
  }

  async get(id: string): Promise<Computer | null> {
    try {
      const { stdout } = await this.cli([
        'ps',
        '-a',
        '--filter',
        `label=husk.id=${id}`,
        '--format',
        '{{.ID}}',
      ]);
      const containerId = stdout.trim().split('\n')[0];
      if (!containerId) return null;
      const info = await this.inspect(containerId);
      return info ? this.wrap(info) : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<ComputerInfo[]> {
    try {
      const { stdout } = await this.cli([
        'ps',
        '-a',
        '--filter',
        `label=husk.provider=${this.cfg.provider}`,
        '--format',
        '{{.ID}}',
      ]);
      const ids = stdout.trim().split('\n').filter(Boolean);
      const out: ComputerInfo[] = [];
      for (const nativeId of ids) {
        const info = await this.inspect(nativeId).catch(() => null);
        if (info) out.push(info);
      }
      return out;
    } catch {
      return [];
    }
  }

  private async inspect(nativeId: string): Promise<ComputerInfo | null> {
    const { stdout } = await this.cli(['inspect', nativeId]);
    const data = JSON.parse(stdout)[0];
    if (!data) return null;
    const labels: Record<string, string> = data.Config?.Labels ?? {};
    const spec = decodeSpec(labels['husk.spec']);
    return {
      id: labels['husk.id'] || data.Id,
      name: String(data.Name ?? '').replace(/^\//, '') || data.Id,
      provider: this.cfg.provider,
      state: readState(data),
      image: data.Config?.Image ?? '',
      workdir: data.Config?.WorkingDir || '/',
      createdAt: data.Created,
      lastUsedAt: data.State?.StartedAt || data.Created,
      spec,
      nativeId: data.Id,
    };
  }
}
