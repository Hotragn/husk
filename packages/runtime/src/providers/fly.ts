import { readFile as readHostFile, mkdir, writeFile as writeHostFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
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
import { GUEST_ROOT, evaluateCommand, normaliseGuestPath, shellQuote } from '../policy.js';
import { expired, forgetInfo, loadInfos, persistInfo } from '../registry.js';
import { parseLsLong } from './oci-common.js';
import { resolveImage } from '../images.js';

/**
 * Fly Machines.
 *
 * A real microVM per computer, started in a couple of seconds, in a region near
 * whoever is waiting. It is last in the priority order for one reason: it is the
 * only provider that spends the user's money, and `auto` must never do that
 * behind their back. It is picked only when nothing free answered.
 *
 * Talks the Machines REST API directly with global `fetch` -- the API is a dozen
 * endpoints, and an SDK would be a dependency plus a version to chase.
 */

export const FLY_API = 'https://api.machines.dev/v1';

export interface FlyOptions {
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  token?: string;
  app?: string;
  region?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Per-request ceiling, in ms. Defaults to 30s; exec overrides it. */
  timeoutMs?: number;
}

interface FlyConfig {
  token: string;
  app: string;
  region: string | undefined;
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}

interface FlyMachine {
  id: string;
  name?: string;
  state?: string;
  region?: string;
  private_ip?: string;
  created_at?: string;
  updated_at?: string;
  config?: {
    image?: string;
    env?: Record<string, string>;
    metadata?: Record<string, string>;
    services?: unknown[];
  };
}

interface FlyExecResponse {
  exit_code?: number;
  exit_signal?: number;
  stdout?: string;
  stderr?: string;
}

/** Fly machine states mapped onto ours. */
function mapState(state: string | undefined): ComputerInfo['state'] {
  switch (state) {
    case 'started':
      return 'running';
    case 'created':
    case 'starting':
    case 'replacing':
      return 'creating';
    case 'suspended':
      return 'paused';
    case 'stopped':
    case 'stopping':
      return 'stopped';
    case 'destroyed':
    case 'destroying':
      return 'destroyed';
    default:
      return 'error';
  }
}

export function resolveFlyConfig(opts: FlyOptions = {}, spec?: ComputerSpec): Partial<FlyConfig> {
  const env = opts.env ?? process.env;
  return {
    token: opts.token ?? env.FLY_API_TOKEN ?? env.FLY_ACCESS_TOKEN ?? '',
    app: opts.app ?? spec?.labels?.['husk.fly.app'] ?? env.HUSK_FLY_APP ?? env.FLY_APP_NAME ?? '',
    region: opts.region ?? spec?.labels?.['husk.fly.region'] ?? env.HUSK_FLY_REGION ?? env.FLY_REGION,
    baseUrl: opts.baseUrl ?? env.HUSK_FLY_API ?? FLY_API,
    fetch: opts.fetch ?? globalThis.fetch,
    timeoutMs: opts.timeoutMs ?? 30_000,
  };
}

/**
 * One request, one timeout, one honest error.
 *
 * Everything that can go wrong with a cloud API -- an expired token, an app that
 * was deleted, a rate limit, a region with no capacity -- arrives as a status
 * code. Mapping them here means every call site gets an actionable message
 * without repeating the mapping.
 */
export async function flyRequest<T>(
  cfg: FlyConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const url = `${cfg.baseUrl}${path}`;
  let res: Response;
  try {
    res = await cfg.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs ?? cfg.timeoutMs),
    });
  } catch (err) {
    const aborted = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    throw new HuskError('E_COMPUTER_FAILED', aborted ? `fly api timed out after ${timeoutMs ?? cfg.timeoutMs}ms` : `cannot reach the fly api: ${(err as Error).message}`, {
      hint: aborted ? 'retry, or check https://status.fly.io' : 'check this machine has outbound https access to api.machines.dev',
      cause: err,
    });
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) throw flyError(res.status, text, cfg.app, method, path);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

export function flyError(status: number, body: string, app: string, method: string, path: string): HuskError {
  const detail = extractMessage(body);
  const base = { status, body: clampText(body, 2000).text, method, path };

  if (status === 401 || status === 403) {
    return new HuskError('E_NO_CREDENTIALS', `fly rejected the token (${status})${detail ? `: ${detail}` : ''}`, {
      hint: 'run `fly auth token` and export it as FLY_API_TOKEN',
      details: base,
    });
  }
  if (status === 404) {
    return new HuskError('E_COMPUTER_NOT_FOUND', `fly returned 404 for ${path}${detail ? `: ${detail}` : ''}`, {
      hint: `check the app "${app}" exists (\`fly apps list\`) and the machine was not already destroyed`,
      details: base,
    });
  }
  if (status === 422) {
    return new HuskError('E_COMPUTER_FAILED', `fly refused the machine config${detail ? `: ${detail}` : ''}`, {
      hint: 'usually an unknown image, an invalid region, or a guest size your org cannot use',
      details: base,
    });
  }
  if (status === 429) {
    return new HuskError('E_QUOTA', 'fly is rate limiting this token', {
      hint: 'wait a minute, or spread work across fewer machines',
      details: base,
    });
  }
  if (status >= 500) {
    return new HuskError('E_COMPUTER_FAILED', `fly api error ${status}${detail ? `: ${detail}` : ''}`, {
      hint: 'this is Fly\'s side; check https://status.fly.io and retry',
      details: base,
    });
  }
  return new HuskError('E_COMPUTER_FAILED', `fly api returned ${status}${detail ? `: ${detail}` : ''}`, {
    hint: `run \`fly machines list -a ${app}\` to see what Fly thinks exists`,
    details: base,
  });
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    return (parsed.error ?? parsed.message ?? '').slice(0, 200);
  } catch {
    return body.slice(0, 200).replace(/\s+/g, ' ').trim();
  }
}

/** Ports the caller wants published, as declared on the spec. */
export function declaredPorts(spec: ComputerSpec): number[] {
  const raw = spec.labels?.['husk.fly.ports'];
  if (!raw) return [];
  return raw
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
}

/**
 * The machine config Fly gets.
 *
 * Exported so the shape can be asserted without a token: this object is the
 * whole contract, and a typo in `guest.memory_mb` is a 422 an hour into a run.
 */
export function buildMachineConfig(spec: ComputerSpec, image: string, workdir: string): Record<string, unknown> {
  const ports = declaredPorts(spec);
  const services = ports.map((port) => ({
    ports: [
      { port: 80, handlers: ['http'] },
      { port: 443, handlers: ['tls', 'http'] },
    ],
    protocol: 'tcp',
    internal_port: port,
  }));

  return {
    image,
    // Fly's guest sizes are shared-cpu-Nx unless you pay for dedicated cores.
    guest: {
      cpu_kind: 'shared',
      cpus: spec.cpus ?? 1,
      // Fly requires memory in 256MB steps and at least 256 per shared cpu.
      memory_mb: Math.max(256, Math.ceil((spec.memoryMb ?? 1024) / 256) * 256),
    },
    env: { ...spec.env, HUSK: '1', HUSK_WORKDIR: workdir },
    // Without an init the machine runs the image's entrypoint and may exit
    // immediately; a computer has to stay up waiting for execs.
    init: { cmd: ['/bin/sh', '-c', `mkdir -p ${workdir} && exec sleep infinity`] },
    restart: { policy: 'no' },
    ...(services.length ? { services } : {}),
    metadata: {
      'husk.id': spec.labels?.['husk.id'] ?? '',
      'husk.provider': 'fly',
    },
  };
}

// ---------------------------------------------------------------------------
// The computer
// ---------------------------------------------------------------------------

class FlyComputer implements Computer {
  readonly info: ComputerInfo;
  private readonly cfg: FlyConfig;
  private destroyed = false;

  constructor(info: ComputerInfo, cfg: FlyConfig) {
    this.info = info;
    this.cfg = cfg;
  }

  get id(): string {
    return this.info.id;
  }

  private get machineId(): string {
    const m = this.info.nativeId;
    if (!m) {
      throw new HuskError('E_COMPUTER_NOT_FOUND', `computer ${this.info.id} has no fly machine behind it`, {
        hint: 'create a new one with `husk up`',
      });
    }
    return m;
  }

  private path(suffix = ''): string {
    return `/apps/${encodeURIComponent(this.cfg.app)}/machines/${encodeURIComponent(this.machineId)}${suffix}`;
  }

  private assertLive(): void {
    if (this.destroyed || this.info.state === 'destroyed') {
      throw new HuskError('E_COMPUTER_NOT_FOUND', `computer ${this.info.id} has been destroyed`, {
        hint: 'create a new one with `husk up`',
      });
    }
  }

  async refresh(): Promise<ComputerInfo> {
    try {
      const m = await flyRequest<FlyMachine>(this.cfg, 'GET', this.path());
      this.info.state = mapState(m.state);
    } catch (err) {
      this.info.state = (err as HuskError).code === 'E_COMPUTER_NOT_FOUND' ? 'destroyed' : 'error';
    }
    return this.info;
  }

  private touch(): void {
    this.info.lastUsedAt = new Date().toISOString();
    void persistInfo(this.info).catch(() => {});
  }

  /**
   * Run a command through the machine exec endpoint.
   *
   * The endpoint is request/response: no stdin, no streaming. `onStdout` still
   * fires, once, when the whole thing lands -- an agent that renders progress
   * gets one update instead of none, and nothing pretends to be a live stream.
   */
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
    if (req.stdin !== undefined) {
      throw new HuskError('E_EXEC_FAILED', 'the fly exec endpoint cannot accept stdin', {
        hint: 'write the input to a file with writeFile and redirect from it',
      });
    }

    const script = typeof req.cmd === 'string' ? req.cmd : shellQuote(req.cmd);
    const env = { ...this.info.spec.env, ...req.env };
    const assignments = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote([v])}`)
      .join(' ');
    const cwd = req.cwd ? normaliseGuestPath(req.cwd, this.info.workdir) : this.info.workdir;
    const wrapped =
      `mkdir -p ${shellQuote([cwd])} && cd ${shellQuote([cwd])} && ` +
      `exec env ${assignments} /bin/sh -c ${shellQuote([script])}`;

    const timeoutSec = req.timeoutSec ?? 120;
    let body: FlyExecResponse;
    try {
      body = await flyRequest<FlyExecResponse>(
        this.cfg,
        'POST',
        this.path('/exec'),
        { command: ['/bin/sh', '-c', wrapped], timeout: timeoutSec > 0 ? timeoutSec : 0 },
        // A little slack over the remote timeout, so the remote one wins and we
        // learn the exit code instead of guessing at a dead socket.
        (timeoutSec > 0 ? timeoutSec + 15 : 3600) * 1000,
      );
    } catch (err) {
      const timedOut = /timed out/.test((err as Error).message);
      if (!timedOut) throw err;
      return {
        exitCode: 124,
        stdout: '',
        stderr: (err as Error).message,
        durationMs: Date.now() - started,
        truncated: false,
        timedOut: true,
      };
    }

    const maxBytes = req.maxOutputBytes ?? 256 * 1024;
    const out = clampText(body.stdout ?? '', maxBytes);
    const err = clampText(body.stderr ?? '', maxBytes);
    if (out.text) req.onStdout?.(out.text);
    if (err.text) req.onStderr?.(err.text);

    this.touch();
    return {
      exitCode: body.exit_code ?? (body.exit_signal ? 128 + body.exit_signal : 0),
      stdout: out.text,
      stderr: err.text,
      durationMs: Date.now() - started,
      truncated: out.truncated || err.truncated,
      timedOut: false,
    };
  }

  /** exec, but for our own plumbing: no command policy, no bookkeeping. */
  private async raw(script: string, timeoutSec = 60): Promise<FlyExecResponse> {
    return await flyRequest<FlyExecResponse>(
      this.cfg,
      'POST',
      this.path('/exec'),
      { command: ['/bin/sh', '-c', script], timeout: timeoutSec },
      (timeoutSec + 15) * 1000,
    );
  }

  /**
   * Files go over the exec endpoint, base64'd and chunked.
   *
   * There is no file API on a Fly machine, and the command line is the only way
   * in. 48 KiB of base64 per call keeps each request well under any argv or
   * proxy limit while still moving a megabyte in about twenty round trips.
   */
  async writeFile(path: string, content: string | Uint8Array, opts: WriteFileOptions = {}): Promise<void> {
    this.assertLive();
    const target = normaliseGuestPath(path, this.info.workdir);
    const q = shellQuote([target]);
    const data = Buffer.from(typeof content === 'string' ? Buffer.from(content, 'utf8') : content).toString('base64');

    if (opts.mkdirp !== false) {
      const mk = await this.raw(`mkdir -p ${shellQuote([posix.dirname(target)])}`);
      if ((mk.exit_code ?? 1) !== 0) {
        throw new HuskError('E_FS_DENIED', `cannot create ${posix.dirname(target)}: ${(mk.stderr ?? '').trim()}`, {
          hint: 'the machine root is writable only where the image made it so',
        });
      }
    }

    const CHUNK = 48 * 1024;
    let first = true;
    for (let i = 0; i < data.length || first; i += CHUNK) {
      const piece = data.slice(i, i + CHUNK);
      const redirect = first && !opts.append ? '>' : '>>';
      const r = await this.raw(`printf %s ${shellQuote([piece])} | base64 -d ${redirect} ${q}`, 120);
      if ((r.exit_code ?? 1) !== 0) {
        throw new HuskError('E_FS_DENIED', `cannot write ${target}: ${(r.stderr ?? '').trim()}`, {
          hint: 'check the path is under a writable directory in the image',
        });
      }
      first = false;
    }
    if (opts.mode) await this.raw(`chmod ${shellQuote([opts.mode])} ${q}`);
    this.touch();
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertLive();
    const target = normaliseGuestPath(path, this.info.workdir);
    const r = await this.raw(`base64 ${shellQuote([target])} | tr -d '\\n'`, 120);
    if ((r.exit_code ?? 1) !== 0) {
      throw new HuskError('E_FS_DENIED', `cannot read ${target}: ${(r.stderr ?? '').trim()}`, {
        hint: 'check the path exists inside the machine',
      });
    }
    this.touch();
    return new Uint8Array(Buffer.from((r.stdout ?? '').trim(), 'base64'));
  }

  async readTextFile(path: string, maxBytes = 1024 * 1024): Promise<string> {
    const buf = await this.readFile(path);
    return clampText(Buffer.from(buf).toString('utf8'), maxBytes).text;
  }

  async listDir(path: string): Promise<DirEntry[]> {
    this.assertLive();
    const target = normaliseGuestPath(path, this.info.workdir);
    const r = await this.raw(`ls -lA ${shellQuote([target])}`);
    if ((r.exit_code ?? 1) !== 0) {
      throw new HuskError('E_FS_DENIED', `cannot list ${target}: ${(r.stderr ?? '').trim()}`, {
        hint: 'check the directory exists inside the machine',
      });
    }
    return parseLsLong(r.stdout ?? '', target);
  }

  async stat(path: string): Promise<DirEntry | null> {
    this.assertLive();
    const target = normaliseGuestPath(path, this.info.workdir);
    const r = await this.raw(`stat -c '%s|%F|%a|%Y' ${shellQuote([target])}`);
    if ((r.exit_code ?? 1) !== 0) return null;
    const [size, kind, mode, mtime] = (r.stdout ?? '').trim().split('|');
    return {
      name: posix.basename(target),
      path: target,
      type: kind?.includes('directory') ? 'dir' : kind?.includes('symbolic') ? 'symlink' : kind?.includes('regular') ? 'file' : 'other',
      size: Number.parseInt(size ?? '0', 10) || 0,
      ...(mtime ? { modifiedAt: new Date(Number(mtime) * 1000).toISOString() } : {}),
      ...(mode ? { mode } : {}),
    };
  }

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    this.assertLive();
    const target = normaliseGuestPath(path, this.info.workdir);
    const r = await this.raw(`rm ${opts.recursive ? '-rf' : '-f'} ${shellQuote([target])}`);
    if ((r.exit_code ?? 1) !== 0) {
      throw new HuskError('E_FS_DENIED', `cannot remove ${target}: ${(r.stderr ?? '').trim()}`, {
        hint: 'check the path is not on a read-only mount',
      });
    }
    this.touch();
  }

  async upload(hostPath: string, targetPath: string): Promise<void> {
    await this.writeFile(targetPath, await readHostFile(hostPath));
  }

  async download(path: string, hostPath: string): Promise<void> {
    const buf = await this.readFile(path);
    await mkdir(dirname(hostPath), { recursive: true });
    await writeHostFile(hostPath, Buffer.from(buf));
  }

  /**
   * Fly publishes ports when the machine is created, not afterwards.
   *
   * So this returns the app's public URL when the port was declared up front,
   * and refuses with the fix when it was not. Handing back a URL that resolves
   * to nothing would be worse than an error.
   */
  async exposePort(port: number): Promise<PortBinding> {
    this.assertLive();
    if (!declaredPorts(this.info.spec).includes(port)) {
      throw new HuskError('E_COMPUTER_FAILED', `port ${port} was not published when this machine was created`, {
        hint: `recreate it with labels."husk.fly.ports" = "${port}" -- Fly attaches services at machine creation`,
        details: { published: declaredPorts(this.info.spec) },
      });
    }
    const url = `https://${this.cfg.app}.fly.dev`;
    const binding: PortBinding = { hostPort: port, url, publicUrl: url };
    this.info.ports = { ...(this.info.ports ?? {}), [port]: binding };
    await persistInfo(this.info).catch(() => {});
    return binding;
  }

  async stop(): Promise<void> {
    this.assertLive();
    await flyRequest(this.cfg, 'POST', this.path('/stop'), {});
    this.info.state = 'stopped';
    await persistInfo(this.info);
  }

  async start(): Promise<void> {
    this.assertLive();
    await flyRequest(this.cfg, 'POST', this.path('/start'), {});
    // Fly answers the start call before the guest is up; the wait endpoint is
    // what makes the next exec a command instead of a 412.
    await flyRequest(this.cfg, 'GET', `${this.path('/wait')}?state=started&timeout=60`, undefined, 70_000).catch(
      () => {},
    );
    this.info.state = 'running';
    await persistInfo(this.info);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      await flyRequest(this.cfg, 'DELETE', `${this.path()}?force=true`);
    } catch (err) {
      // A machine Fly already forgot is a machine we do not have to bill for.
      if ((err as HuskError).code !== 'E_COMPUTER_NOT_FOUND') {
        this.info.state = 'error';
        await persistInfo(this.info).catch(() => {});
        throw err;
      }
    }
    this.info.state = 'destroyed';
    await forgetInfo(this.info.id);
  }
}

function splitList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v.split('\u0000').filter(Boolean);
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export class FlyProvider implements ComputerProvider {
  readonly name: ProviderName = 'fly';
  readonly description = 'A Fly.io microVM per computer. Real isolation, metered by the second.';
  /** Lowest on purpose: `auto` must never reach for the paid option first. */
  readonly priority = 14;

  private readonly opts: FlyOptions;

  constructor(opts: FlyOptions = {}) {
    this.opts = opts;
  }

  private config(spec?: ComputerSpec): FlyConfig {
    const c = resolveFlyConfig(this.opts, spec);
    if (!c.token) {
      throw new HuskError('E_NO_CREDENTIALS', 'FLY_API_TOKEN is not set', {
        hint: 'run `fly auth token` and export it as FLY_API_TOKEN',
      });
    }
    if (!c.app) {
      throw new HuskError('E_CONFIG', 'no fly app is configured', {
        hint: 'run `fly apps create husk` and export HUSK_FLY_APP=husk',
      });
    }
    if (!c.fetch) {
      throw new HuskError('E_INTERNAL', 'this node build has no global fetch', {
        hint: 'husk needs Node 20.10 or newer',
      });
    }
    return c as FlyConfig;
  }

  async isAvailable(): Promise<Availability> {
    const c = resolveFlyConfig(this.opts);
    if (!c.token) {
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: 'FLY_API_TOKEN is not set',
        hint: 'run `fly auth token` and export it as FLY_API_TOKEN (fly machines are metered, not free)',
      };
    }
    if (!c.app) {
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: 'a fly token is present but no app is configured',
        hint: 'run `fly apps create husk` and export HUSK_FLY_APP=husk',
      };
    }

    try {
      const cfg = this.config();
      const app = await flyRequest<{ name?: string; status?: string; organization?: { slug?: string } }>(
        cfg,
        'GET',
        `/apps/${encodeURIComponent(cfg.app)}`,
        undefined,
        12_000,
      );
      return {
        available: true,
        isolated: true,
        isolationKind: 'kernel',
        version: `fly machines api · app ${app?.name ?? cfg.app}${app?.organization?.slug ? ` (${app.organization.slug})` : ''}`,
        reason: 'a microVM per computer, billed by the second while it runs',
      };
    } catch (err) {
      const e = err as HuskError;
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: e.message,
        hint: e.hint ?? 'run `fly apps list` to check the token and the app',
      };
    }
  }

  async create(spec: ComputerSpec): Promise<Computer> {
    const cfg = this.config(spec);
    const id = newId('cmp');
    const workdir = spec.workdir ?? GUEST_ROOT;
    // Fly pulls the image itself, so there is nothing to probe locally; the
    // public fallback is the safe default because our registry may be private.
    const plan = resolveImage(spec);
    const image = spec.image ?? plan.fallback;

    const machine = await flyRequest<FlyMachine>(
      cfg,
      'POST',
      `/apps/${encodeURIComponent(cfg.app)}/machines`,
      {
        name: `husk-${id.replace(/[^a-z0-9-]/g, '')}`.slice(0, 62),
        ...(cfg.region ? { region: cfg.region } : {}),
        config: buildMachineConfig({ ...spec, labels: { ...spec.labels, 'husk.id': id } }, image, workdir),
      },
      120_000,
    );

    if (!machine?.id) {
      throw new HuskError('E_COMPUTER_FAILED', 'fly accepted the request but returned no machine id', {
        hint: `run \`fly machines list -a ${cfg.app}\` and destroy anything orphaned`,
      });
    }

    const now = new Date().toISOString();
    const info: ComputerInfo = {
      id,
      name: spec.name ?? id,
      provider: 'fly',
      state: 'creating',
      image,
      workdir,
      createdAt: now,
      lastUsedAt: now,
      nativeId: machine.id,
      spec: { ...spec, provider: 'fly', labels: { ...(spec.labels ?? {}), 'husk.fly.app': cfg.app } },
    };
    await persistInfo(info);

    const computer = new FlyComputer(info, cfg);
    try {
      await flyRequest(
        cfg,
        'GET',
        `/apps/${encodeURIComponent(cfg.app)}/machines/${machine.id}/wait?state=started&timeout=60`,
        undefined,
        70_000,
      );
    } catch (err) {
      // A machine that never booted is a machine that still bills. Take it down
      // rather than leaving it for the reaper.
      await computer.destroy().catch(() => {});
      throw err;
    }

    info.state = 'running';
    await persistInfo(info);
    if (spec.setup) await computer.exec({ cmd: spec.setup, timeoutSec: 300 });
    return computer;
  }

  async get(id: string): Promise<Computer | null> {
    const info = (await loadInfos('fly')).find((i) => i.id === id || i.name === id);
    if (!info || info.state === 'destroyed') return null;
    try {
      return new FlyComputer(info, this.config(info.spec));
    } catch {
      return null;
    }
  }

  /**
   * Fly is the source of truth, with the local records as the fallback.
   *
   * A machine that exists and is not in our records is still costing money, so
   * it is reported rather than hidden.
   */
  async list(): Promise<ComputerInfo[]> {
    const local = (await loadInfos('fly')).filter((i) => i.state !== 'destroyed');
    let cfg: FlyConfig;
    try {
      cfg = this.config();
    } catch {
      return local;
    }

    let machines: FlyMachine[];
    try {
      machines = (await flyRequest<FlyMachine[]>(cfg, 'GET', `/apps/${encodeURIComponent(cfg.app)}/machines`)) ?? [];
    } catch {
      return local;
    }

    const byNative = new Map(local.map((i) => [i.nativeId, i]));
    const out: ComputerInfo[] = [];
    for (const m of machines) {
      if (m.config?.metadata?.['husk.provider'] !== 'fly') continue;
      const known = byNative.get(m.id);
      const huskId = known?.id ?? m.config?.metadata?.['husk.id'] ?? m.id;
      out.push({
        ...(known ?? {
          id: huskId,
          name: m.name ?? huskId,
          provider: 'fly' as ProviderName,
          image: m.config?.image ?? '',
          workdir: m.config?.env?.HUSK_WORKDIR ?? GUEST_ROOT,
          createdAt: m.created_at ?? new Date().toISOString(),
          lastUsedAt: m.updated_at ?? m.created_at ?? new Date().toISOString(),
          spec: {} as ComputerSpec,
        }),
        state: mapState(m.state),
        nativeId: m.id,
      });
    }
    return out;
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
