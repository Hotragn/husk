/**
 * The computer contract.
 *
 * A Husk "computer" is a small, disposable Linux machine an agent can drive.
 * Every provider -- Docker, Podman, a plain guarded directory, SSH, Fly --
 * implements this same surface, so an agent never learns where it is running.
 */

export type ProviderName = 'docker' | 'podman' | 'local' | 'ssh' | 'fly' | (string & {});

export type ComputerState = 'creating' | 'running' | 'paused' | 'stopped' | 'destroyed' | 'error';

/** How much the machine is allowed to talk to the outside world. */
export interface NetworkPolicy {
  /** none: no egress at all. egress: allowlist only. full: unrestricted. */
  mode: 'none' | 'egress' | 'full';
  /** Hostnames or CIDRs permitted when mode === 'egress'. Supports leading '*.' wildcards. */
  allow?: string[];
  /** Always-denied hosts, applied even in 'full' mode. */
  deny?: string[];
}

export interface MountSpec {
  /** Absolute path on the host. */
  source: string;
  /** Absolute path inside the computer. */
  target: string;
  readonly?: boolean;
}

/** Prebuilt environments. A provider maps these onto concrete images. */
export type Flavor = 'base' | 'python' | 'node' | 'full';

export interface ComputerSpec {
  /** Human label. Also used for the container name when it is unique. */
  name?: string;
  provider?: ProviderName;
  /** Explicit image reference. Overrides `flavor`. */
  image?: string;
  flavor?: Flavor;
  cpus?: number;
  memoryMb?: number;
  diskMb?: number;
  /** Destroy the computer after this many seconds of no exec activity. 0 disables. */
  idleTimeoutSec?: number;
  /** Hard ceiling on total lifetime regardless of activity. 0 disables. */
  maxLifetimeSec?: number;
  network?: NetworkPolicy;
  env?: Record<string, string>;
  mounts?: MountSpec[];
  /** Default working directory. Defaults to /work. */
  workdir?: string;
  /** Unprivileged user inside the machine. Defaults to `husk`. */
  user?: string;
  /** Keep the filesystem across restarts (named volume / retained directory). */
  persist?: boolean;
  /** Extra packages to install on first boot, resolved by the flavor's package manager. */
  packages?: string[];
  /** Shell snippet run once after creation. */
  setup?: string;
  labels?: Record<string, string>;
}

export interface ComputerInfo {
  id: string;
  name: string;
  provider: ProviderName;
  state: ComputerState;
  image: string;
  workdir: string;
  createdAt: string;
  lastUsedAt: string;
  spec: ComputerSpec;
  /** Provider-native handle (container id, machine id, pid namespace, ...). */
  nativeId?: string;
  /** Ports published to the host, keyed by the in-computer port. */
  ports?: Record<number, PortBinding>;
  /**
   * Set when `image` is not the image the spec asked for.
   *
   * husk prefers its own images and falls back to a stock public one when the
   * registry has nothing -- which is every install until the images are
   * published. The fallback is a bare `debian:bookworm-slim`: no python3, no
   * curl, no `huskinfo`, and no `husk` user. That is a perfectly usable Linux
   * box and a surprising one if you were told you had the other, so the
   * substitution is recorded rather than performed quietly.
   */
  imageFallback?: { wanted: string; reason: string };
  error?: string;
}

export interface PortBinding {
  hostPort: number;
  url: string;
  /** Set when the provider can offer a public tunnel. */
  publicUrl?: string;
  /**
   * Whether anything actually answered on `url` when the binding was made.
   *
   * `false` is not necessarily an error -- an agent that exposes a port before
   * its server finishes starting is the ordinary case -- but a URL nobody has
   * ever connected to should not be handed back as though it were known good.
   * Undefined means the provider did not check.
   */
  reachable?: boolean;
}

export interface ExecRequest {
  /** A shell string, or an argv array to execute without a shell. */
  cmd: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  stdin?: string;
  user?: string;
  /** Allocate a pty. Required for interactive tools and for programs that check isatty. */
  tty?: boolean;
  /** Output is clamped to this many bytes per stream. Defaults to 256 KiB. */
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  modifiedAt?: string;
  mode?: string;
}

export interface WriteFileOptions {
  /** Octal string, e.g. '0755'. */
  mode?: string;
  /** Create parent directories. Defaults to true. */
  mkdirp?: boolean;
  append?: boolean;
}

/** A live computer. All paths are absolute inside the machine unless noted. */
export interface Computer {
  readonly id: string;
  readonly info: ComputerInfo;

  refresh(): Promise<ComputerInfo>;
  exec(req: ExecRequest): Promise<ExecResult>;

  writeFile(path: string, content: string | Uint8Array, opts?: WriteFileOptions): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string, maxBytes?: number): Promise<string>;
  listDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<DirEntry | null>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;

  /** Copy a host path into the machine. Directories are copied recursively. */
  upload(hostPath: string, targetPath: string): Promise<void>;
  /** Copy a machine path back out to the host. */
  download(path: string, hostPath: string): Promise<void>;

  /** Publish an in-computer port to the host. Idempotent. */
  exposePort(port: number): Promise<PortBinding>;

  stop(): Promise<void>;
  start(): Promise<void>;
  destroy(): Promise<void>;

  /** Optional capabilities -- callers must feature-detect. */
  snapshot?(name?: string): Promise<{ id: string; sizeBytes?: number }>;
  restore?(snapshotId: string): Promise<void>;
}

export interface Availability {
  available: boolean;
  /** Why it is not available, in one line. */
  reason?: string;
  /** What the user should do about it, in one line. */
  hint?: string;
  version?: string;
  /** True when the boundary is real. See `isolationKind` for what kind of real. */
  isolated?: boolean;
  /**
   * What the boundary actually is.
   *
   * - `kernel` — namespaces and cgroups on this machine (docker, podman, fly).
   * - `machine` — a different computer entirely (ssh). Isolated from *your* laptop,
   *   but the agent still holds your user's shell on the far end, so it is not
   *   isolated from that box. Rendering this as a plain green "isolated" badge
   *   overclaims, which is the whole reason this field exists.
   * - `guardrails` — process-level checks only (local). Stops accidents, not attackers.
   */
  isolationKind?: 'kernel' | 'machine' | 'guardrails';
}

export interface ComputerProvider {
  readonly name: ProviderName;
  /** One-line description shown in `husk doctor`. */
  readonly description: string;
  /** Higher wins when auto-selecting a provider. */
  readonly priority: number;

  isAvailable(): Promise<Availability>;
  create(spec: ComputerSpec): Promise<Computer>;
  get(id: string): Promise<Computer | null>;
  list(): Promise<ComputerInfo[]>;
  /** Remove computers that have outlived their idle or lifetime budget. */
  reap?(): Promise<string[]>;
}
