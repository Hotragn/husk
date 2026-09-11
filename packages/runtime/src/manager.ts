import { readFile, mkdir, readdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HuskError, createLogger, ensurePaths } from '@husk/core';
import { forgetInfo, loadInfos } from './registry.js';
import type {
  Availability,
  Computer,
  ComputerInfo,
  ComputerProvider,
  ComputerSpec,
  Logger,
  ProviderName,
} from '@husk/core';
import { LocalProvider } from './providers/local.js';
import { DockerProvider } from './providers/docker.js';
import { PodmanProvider } from './providers/podman.js';
import { SshProvider } from './providers/ssh.js';
import { FlyProvider } from './providers/fly.js';

export interface ProviderStatus extends Availability {
  name: ProviderName;
  description: string;
  priority: number;
}

export interface ComputerManagerOptions {
  /** Hard ceiling on live machines. Defaults to 8. */
  maxComputers?: number;
  /** How long a provider availability probe stays fresh. Defaults to 30s. */
  probeTtlMs?: number;
  logger?: Logger;
  /**
   * Replace the built-in provider set. Used by tests and by embedders that want
   * one specific backend; leaving it unset registers all five.
   */
  providers?: ComputerProvider[];
}

/**
 * The order `auto` walks, highest first.
 *
 * docker > podman > ssh > fly > local. Real isolation wins over guardrails,
 * free wins over metered, and `local` sits at the bottom as the floor that is
 * always there -- so an empty machine still gets a computer, and a machine with
 * options never silently settles for the weakest one.
 */
export function defaultProviders(): ComputerProvider[] {
  return [new DockerProvider(), new PodmanProvider(), new SshProvider(), new FlyProvider(), new LocalProvider()];
}

/**
 * The façade every other package uses.
 *
 * Owns provider selection, the stable-key computer cache that lets one
 * conversation keep one machine, the quota, and the reaper.
 */
export class ComputerManager {
  private readonly providers = new Map<ProviderName, ComputerProvider>();
  private readonly probes = new Map<ProviderName, { at: number; result: Availability }>();
  private readonly log: Logger;
  private readonly maxComputers: number;
  private readonly probeTtlMs: number;
  private reaper: ReturnType<typeof setInterval> | undefined;
  /** In-flight creates, so two concurrent `ensure` calls cannot race into two machines. */
  private readonly pending = new Map<string, Promise<Computer>>();
  /** Binding keys this manager holds a ref on, so it takes exactly one each. */
  private readonly held = new Set<string>();

  constructor(opts: ComputerManagerOptions = {}) {
    this.maxComputers = opts.maxComputers ?? 8;
    this.probeTtlMs = opts.probeTtlMs ?? 30_000;
    this.log = opts.logger ?? createLogger({ scope: 'runtime' });
    for (const p of opts.providers ?? defaultProviders()) this.register(p);
  }

  register(provider: ComputerProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProviders(): ComputerProvider[] {
    return [...this.providers.values()].sort((a, b) => b.priority - a.priority);
  }

  getProvider(name: ProviderName): ComputerProvider | undefined {
    return this.providers.get(name);
  }

  /** Probe one provider, reusing a recent answer. Probes are slow; agents are chatty. */
  async probe(name: ProviderName, force = false): Promise<Availability> {
    const provider = this.providers.get(name);
    if (!provider) {
      return { available: false, reason: `no provider named ${name}` };
    }
    const cached = this.probes.get(name);
    if (!force && cached && Date.now() - cached.at < this.probeTtlMs) return cached.result;

    let result: Availability;
    try {
      result = await provider.isAvailable();
    } catch (err) {
      result = {
        available: false,
        reason: `probe failed: ${(err as Error).message}`,
        hint: 'this is usually a broken install of the underlying tool',
      };
    }
    this.probes.set(name, { at: Date.now(), result });
    return result;
  }

  /** Everything `husk doctor` needs, in one call. */
  async status(force = false): Promise<ProviderStatus[]> {
    return Promise.all(
      this.getProviders().map(async (p) => ({
        name: p.name,
        description: p.description,
        priority: p.priority,
        ...(await this.probe(p.name, force)),
      })),
    );
  }

  /**
   * Pick a provider.
   *
   * An explicit name is honoured even when unavailable -- but the error says why,
   * rather than silently falling back to something with weaker isolation than the
   * caller asked for. That substitution is exactly the kind of surprise that turns
   * into a security incident.
   */
  async resolveProvider(name: ProviderName | 'auto' = 'auto'): Promise<ComputerProvider> {
    if (name !== 'auto') {
      const p = this.providers.get(name);
      if (!p) {
        throw new HuskError('E_PROVIDER_UNAVAILABLE', `unknown provider: ${name}`, {
          hint: `known providers: ${[...this.providers.keys()].join(', ')}`,
        });
      }
      const a = await this.probe(name);
      if (!a.available) {
        throw new HuskError('E_PROVIDER_UNAVAILABLE', `provider "${name}" is not usable: ${a.reason ?? 'unknown'}`, {
          hint: a.hint ?? 'run `husk doctor` to see what is available',
        });
      }
      return p;
    }

    const rejected: string[] = [];
    for (const p of this.getProviders()) {
      const a = await this.probe(p.name);
      if (a.available) {
        if (a.isolated === false) {
          this.log.warn(`using the ${p.name} provider: ${a.reason ?? 'not isolated'}`);
        }
        return p;
      }
      rejected.push(`${p.name}: ${a.reason ?? 'unavailable'}`);
    }

    throw new HuskError('E_PROVIDER_UNAVAILABLE', 'no computer provider is usable', {
      hint: 'run `husk doctor` for the full picture',
      details: { rejected },
    });
  }

  private async assertQuota(): Promise<void> {
    const live = (await this.list()).filter((c) => c.state === 'running' || c.state === 'creating');
    if (live.length >= this.maxComputers) {
      throw new HuskError('E_QUOTA', `already running ${live.length} computers (limit ${this.maxComputers})`, {
        hint: 'destroy one with `husk rm <name>`, or raise maxComputers in ~/.husk/config.json',
      });
    }
  }

  async create(spec: ComputerSpec = {}): Promise<Computer> {
    await this.assertQuota();
    const provider = await this.resolveProvider(spec.provider ?? 'auto');
    const computer = await provider.create({ ...spec, provider: provider.name });
    this.log.debug(`created ${computer.id} on ${provider.name}`);
    return computer;
  }

  /**
   * Get the machine for a stable key, creating it on first use.
   *
   * This is what lets a Claude Code session keep one filesystem across many tool
   * calls without the caller tracking ids. Concurrent callers with the same key
   * share one in-flight create rather than racing into two machines.
   *
   * The key is the unit of sharing, so choosing it is a privacy decision, not a
   * naming one. Anything serving more than one session -- the HTTP MCP endpoint
   * especially -- must derive a key per session; see `sessionBindingKey` in
   * `@husk/server`. Two sessions that share a key share a `/work`.
   *
   * A caller that will finish should pair this with `release(key)`, which drops
   * its hold and reclaims the machine once nothing else is using it.
   */
  async ensure(key: string, spec: ComputerSpec = {}): Promise<Computer> {
    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const existingId = await readBinding(key);
    if (existingId) {
      const found = await this.get(existingId);
      if (found && found.info.state !== 'destroyed') {
        await this.takeRef(key, found.id);
        return found;
      }
      await clearBinding(key);
    }

    const p = (async () => {
      const computer = await this.create({ ...spec, labels: { ...(spec.labels ?? {}), 'husk.key': key } });
      await this.takeRef(key, computer.id);
      return computer;
    })();

    this.pending.set(key, p);
    try {
      return await p;
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * Count this manager as one holder of `key`, at most once.
   *
   * `ensure` is called on every tool call, and counting each of those would
   * make the refcount a call counter rather than a holder count.
   */
  private async takeRef(key: string, id: string): Promise<void> {
    if (this.held.has(key)) return;
    this.held.add(key);
    await addRef(key, id);
  }

  /**
   * Give up this manager's hold on `key`.
   *
   * Destroys the computer when no holder is left, which is what makes an
   * ephemeral session actually ephemeral without a session's disconnect taking
   * a concurrent session's filesystem with it. Returns whether it was
   * destroyed.
   */
  async release(key: string, opts: { destroy?: boolean } = {}): Promise<boolean> {
    if (!this.held.delete(key)) return false;
    const { refs, id } = await dropRef(key);
    if (refs !== 0 || !id) return false;
    if (opts.destroy === false) return false;

    const c = await this.get(id);
    if (!c) {
      await this.forget(id);
      return false;
    }
    await c.destroy();
    this.log.debug(`released ${key}: last holder gone, destroyed ${id}`);
    return true;
  }

  /** Keys this manager currently holds, for shutdown. */
  heldKeys(): string[] {
    return [...this.held];
  }

  async get(id: string): Promise<Computer | null> {
    for (const p of this.providers.values()) {
      try {
        const c = await p.get(id);
        if (c) return c;
      } catch {
        // One broken provider must not hide a machine owned by another.
      }
    }
    return null;
  }

  async list(): Promise<ComputerInfo[]> {
    const all: ComputerInfo[] = [];
    for (const p of this.providers.values()) {
      try {
        all.push(...(await p.list()));
      } catch (err) {
        this.log.debug(`provider ${p.name} could not list computers`, err);
      }
    }
    return all.sort(
      (a, b) => new Date(b.lastUsedAt || b.createdAt).getTime() - new Date(a.lastUsedAt || a.createdAt).getTime(),
    );
  }

  async destroy(id: string): Promise<boolean> {
    const c = await this.get(id);
    if (!c) return await this.forget(id);
    const key = c.info.spec.labels?.['husk.key'];
    await c.destroy();
    if (key) await clearBinding(key);
    return true;
  }

  /**
   * Remove a registry record whose machine is already gone.
   *
   * A provider's `get()` returns null once the backing workspace or container
   * has vanished, while `list()` still reads the JSON record -- so the computer
   * showed in `husk ps`, could not be resolved by any command, and could not be
   * destroyed either. `husk rm --all` printed "destroying 1" then "destroyed 0"
   * and exited zero. Cleaning up the record is the destroy that was asked for:
   * the machine is gone, and the only thing left to remove is the bookkeeping.
   */
  async forget(id: string): Promise<boolean> {
    const infos = await loadInfos();
    const info = infos.find((i) => i.id === id || i.name === id);
    if (!info) return false;
    const key = info.spec.labels?.['husk.key'];
    await forgetInfo(info.id);
    if (key) await clearBinding(key);
    this.log.debug(`forgot stale record ${info.id} (${info.provider}); its machine was already gone`);
    return true;
  }

  async destroyAll(): Promise<number> {
    const all = await this.list();
    let n = 0;
    for (const info of all) {
      if (await this.destroy(info.id)) n++;
    }
    return n;
  }

  /**
   * Workspace directories with no registry record.
   *
   * Cleanup is non-transactional in both directions: a record can outlive its
   * workspace (see `forget`) and a workspace can outlive its record, which is
   * how a machine accumulates orphan directories holding real files and real
   * disk. Neither `husk ps` nor `husk rm` could see these at all.
   */
  async orphanWorkspaces(): Promise<string[]> {
    const p = ensurePaths();
    let dirs: string[];
    try {
      dirs = await readdir(p.workspaces);
    } catch {
      return [];
    }
    const known = new Set((await loadInfos()).map((i) => i.id));
    return dirs.filter((d) => d.startsWith('cmp_') && !known.has(d)).map((d) => join(p.workspaces, d));
  }

  /** Delete the directories `orphanWorkspaces` found. Returns the count removed. */
  async pruneOrphanWorkspaces(): Promise<number> {
    let n = 0;
    for (const dir of await this.orphanWorkspaces()) {
      try {
        await rm(dir, { recursive: true, force: true });
        n++;
      } catch (err) {
        this.log.debug(`could not remove orphan workspace ${dir}`, err);
      }
    }
    return n;
  }

  /** Sweep machines past their idle or lifetime budget. Returns the ids removed. */
  async reap(): Promise<string[]> {
    const removed: string[] = [];
    for (const p of this.providers.values()) {
      if (!p.reap) continue;
      try {
        removed.push(...(await p.reap()));
      } catch (err) {
        this.log.debug(`reaper failed for ${p.name}`, err);
      }
    }
    if (removed.length) this.log.info(`reaped ${removed.length} idle computer(s)`);
    return removed;
  }

  /** Start the background reaper. Idempotent; `unref`ed so it never holds a CLI open. */
  startReaper(intervalMs = 60_000): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => void this.reap().catch(() => {}), intervalMs);
    this.reaper.unref?.();
  }

  stopReaper(): void {
    if (!this.reaper) return;
    clearInterval(this.reaper);
    this.reaper = undefined;
  }
}

// ---------------------------------------------------------------------------
// key -> computer bindings
// ---------------------------------------------------------------------------

/**
 * What a binding key holds.
 *
 * `refs` is the addition that matters. The first version of this file mapped a
 * key straight to an id, which meant two concurrent holders of one key could
 * not be told apart: whichever finished first destroyed the computer, and the
 * other one started failing on paths that had been valid a moment earlier.
 * That was a cooperative-sharing footgun for two terminals running one husk. It
 * becomes a correctness bug the moment one HTTP endpoint serves many chat
 * sessions, so the count is tracked rather than assumed to be one.
 */
export interface BindingRecord {
  id: string;
  /** Live holders of this key. A computer is only reclaimed at zero. */
  refs: number;
  boundAt: string;
  lastUsedAt: string;
}

interface BindingsFileV2 {
  version: 2;
  bindings: Record<string, BindingRecord>;
}

function bindingsFile(): string {
  return join(ensurePaths().computers, 'bindings.json');
}

/**
 * Serialise every read-modify-write in this process.
 *
 * The file is written with write-then-rename so it is never half-parsed, but
 * that does not make `read; mutate; write` atomic -- and with refcounts an
 * interleaving loses a decrement, which strands a computer forever. Two husk
 * processes can still race; see the follow-ups in docs/SPEC-remote-mcp.md.
 */
let bindingQueue: Promise<unknown> = Promise.resolve();

function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = bindingQueue.then(fn, fn);
  bindingQueue = next.catch(() => {});
  return next;
}

async function readBindings(): Promise<BindingsFileV2> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(bindingsFile(), 'utf8'));
  } catch {
    return { version: 2, bindings: {} };
  }
  if (!parsed || typeof parsed !== 'object') return { version: 2, bindings: {} };

  const obj = parsed as Record<string, unknown>;
  if (obj.version === 2 && obj.bindings && typeof obj.bindings === 'object') {
    return { version: 2, bindings: obj.bindings as Record<string, BindingRecord> };
  }

  // v1: a flat `key -> id` map, written by every husk before refcounting. An
  // existing binding is assumed to have exactly one holder, which is what it
  // meant, so an upgrade does not orphan a machine someone is using.
  const now = new Date().toISOString();
  const bindings: Record<string, BindingRecord> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') bindings[key] = { id: value, refs: 1, boundAt: now, lastUsedAt: now };
  }
  return { version: 2, bindings };
}

async function writeBindings(file: BindingsFileV2): Promise<void> {
  const target = bindingsFile();
  await mkdir(join(target, '..'), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
  await rename(tmp, target);
}

async function readBinding(key: string): Promise<string | undefined> {
  return (await readBindings()).bindings[key]?.id;
}

/** Bind `key` to `id` with one holder, or add a holder to an existing binding. */
async function addRef(key: string, id: string): Promise<number> {
  return await serialised(async () => {
    const file = await readBindings();
    const now = new Date().toISOString();
    const existing = file.bindings[key];
    if (existing && existing.id === id) {
      existing.refs = Math.max(0, existing.refs) + 1;
      existing.lastUsedAt = now;
    } else {
      file.bindings[key] = { id, refs: 1, boundAt: now, lastUsedAt: now };
    }
    await writeBindings(file);
    return file.bindings[key]!.refs;
  });
}

/** Drop a holder. Returns the remaining count, or -1 when the key was unknown. */
async function dropRef(key: string): Promise<{ refs: number; id: string | undefined }> {
  return await serialised(async () => {
    const file = await readBindings();
    const existing = file.bindings[key];
    if (!existing) return { refs: -1, id: undefined };
    existing.refs = existing.refs - 1;
    existing.lastUsedAt = new Date().toISOString();
    const id = existing.id;
    if (existing.refs <= 0) delete file.bindings[key];
    await writeBindings(file);
    return { refs: Math.max(0, existing.refs), id };
  });
}

async function clearBinding(key: string): Promise<void> {
  await serialised(async () => {
    const file = await readBindings();
    if (!(key in file.bindings)) return;
    delete file.bindings[key];
    await writeBindings(file);
  });
}

/** Every live binding, for `husk ps` and the doctor. */
export async function listBindings(): Promise<Record<string, BindingRecord>> {
  return (await readBindings()).bindings;
}

/** Remove the bindings file entirely. Used by `husk reset`. */
export async function clearAllBindings(): Promise<void> {
  await rm(bindingsFile(), { force: true });
}
