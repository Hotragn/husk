import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HuskError, createLogger, ensurePaths, notifyComputerDestroyed } from '@husk-ai/core';
import type {
  Availability,
  Computer,
  ComputerInfo,
  ComputerProvider,
  ComputerSpec,
  Logger,
  ProviderName,
} from '@husk-ai/core';
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
   */
  async ensure(key: string, spec: ComputerSpec = {}): Promise<Computer> {
    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const existingId = await readBinding(key);
    if (existingId) {
      const found = await this.get(existingId);
      if (found && found.info.state !== 'destroyed') return found;
      await clearBinding(key);
    }

    const p = (async () => {
      const computer = await this.create({
        // A computer reached by a stable key is somebody's bot -- one chat, one
        // session, one machine -- and it is expected to still be there
        // tomorrow. Anonymous `create()` machines stay ephemeral; these do not.
        //
        // This was the gap behind a claim husk was already making: the MCP
        // server tells its client "/work persists for this session" while the
        // container providers mounted the workspace as a tmpfs, so the files
        // and, worse, the browser profile with all its logins died with the
        // container. Persisting by key makes the sentence true.
        persist: true,
        ...spec,
        labels: { ...(spec.labels ?? {}), 'husk.key': key },
      });
      await writeBinding(key, computer.id);
      return computer;
    })();

    this.pending.set(key, p);
    try {
      return await p;
    } finally {
      this.pending.delete(key);
    }
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
    if (!c) return false;
    const key = c.info.spec.labels?.['husk.key'];
    // Before the machine goes, not after: a browser's `close()` runs a `pkill`
    // *inside* the computer, which only works while the computer still exists.
    await notifyComputerDestroyed(id);
    await c.destroy();
    if (key) await clearBinding(key);
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

function bindingsFile(): string {
  return join(ensurePaths().computers, 'bindings.json');
}

async function readBindings(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(bindingsFile(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeBindings(map: Record<string, string>): Promise<void> {
  const target = bindingsFile();
  await mkdir(join(target, '..'), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await rename(tmp, target);
}

async function readBinding(key: string): Promise<string | undefined> {
  return (await readBindings())[key];
}

async function writeBinding(key: string, id: string): Promise<void> {
  const map = await readBindings();
  map[key] = id;
  await writeBindings(map);
}

async function clearBinding(key: string): Promise<void> {
  const map = await readBindings();
  if (!(key in map)) return;
  delete map[key];
  await writeBindings(map);
}

/** Remove the bindings file entirely. Used by `husk reset`. */
export async function clearAllBindings(): Promise<void> {
  await rm(bindingsFile(), { force: true });
}
