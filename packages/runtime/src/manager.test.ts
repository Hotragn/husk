import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@husk/core';
import type { Availability, Computer, ComputerInfo, ComputerProvider, ComputerSpec } from '@husk/core';
import { ComputerManager, defaultProviders } from './manager.js';
import { listBindings } from './manager.js';
import { loadInfos, persistInfo } from './registry.js';

/**
 * Selection is the decision with the worst failure mode in the package.
 *
 * Picking the wrong provider means an agent runs somewhere weaker than the
 * caller believed, or somewhere that bills them. Both are silent. So the order,
 * the fallback and the refusal to substitute are tested with fake providers,
 * which is also the only way to test them on a machine with no engines at all.
 */

class FakeProvider implements ComputerProvider {
  probes = 0;

  constructor(
    readonly name: string,
    readonly priority: number,
    private readonly availability: Availability | (() => Promise<Availability>),
    readonly description = `fake ${name}`,
  ) {}

  async isAvailable(): Promise<Availability> {
    this.probes++;
    return typeof this.availability === 'function' ? await this.availability() : this.availability;
  }

  async create(_spec: ComputerSpec): Promise<Computer> {
    throw new Error('not used');
  }

  async get(_id: string): Promise<Computer | null> {
    return null;
  }

  async list(): Promise<ComputerInfo[]> {
    return [];
  }
}

const up = (isolated?: boolean): Availability => ({ available: true, ...(isolated === undefined ? {} : { isolated }) });
const down = (reason: string, hint: string): Availability => ({ available: false, reason, hint });

/** Quiet: resolveProvider warns when it lands on something unisolated. */
const silent = createLogger({ scope: 'test', level: 'silent' });

function manager(providers: ComputerProvider[]): ComputerManager {
  return new ComputerManager({ providers, logger: silent });
}

describe('the built-in provider set', () => {
  it('registers all five', () => {
    expect(new ComputerManager({ logger: silent }).getProviders().map((p) => p.name)).toEqual([
      'docker',
      'podman',
      'ssh',
      'fly',
      'local',
    ]);
  });

  it('orders them docker > podman > ssh > fly > local', () => {
    const byName = new Map(defaultProviders().map((p) => [p.name, p.priority]));
    const order = ['docker', 'podman', 'ssh', 'fly', 'local'];
    for (let i = 1; i < order.length; i++) {
      expect(byName.get(order[i - 1]!)!).toBeGreaterThan(byName.get(order[i]!)!);
    }
  });

  it('puts the only unisolated provider last, and the only metered one above it', () => {
    const ps = defaultProviders().sort((a, b) => b.priority - a.priority);
    expect(ps.at(-1)?.name).toBe('local');
    expect(ps.at(-2)?.name).toBe('fly');
  });

  it('gives every provider a one-line description for `husk doctor`', () => {
    for (const p of defaultProviders()) {
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.description).not.toContain('\n');
    }
  });
});

describe('resolveProvider', () => {
  it('picks the highest-priority available provider', async () => {
    const m = manager([
      new FakeProvider('low', 1, up(true)),
      new FakeProvider('high', 9, up(true)),
      new FakeProvider('mid', 5, up(true)),
    ]);
    expect((await m.resolveProvider('auto')).name).toBe('high');
  });

  it('falls past everything unavailable, in order', async () => {
    const docker = new FakeProvider('docker', 20, down('daemon is not running', 'start Docker Desktop'));
    const podman = new FakeProvider('podman', 18, down('machine is not started', 'podman machine start'));
    const ssh = new FakeProvider('ssh', 16, down('no remote host', 'export HUSK_SSH_TARGET'));
    const fly = new FakeProvider('fly', 14, down('no token', 'fly auth token'));
    const local = new FakeProvider('local', 10, { available: true, isolated: false });

    expect((await manager([local, fly, ssh, podman, docker]).resolveProvider('auto')).name).toBe('local');
    expect([docker.probes, podman.probes, ssh.probes, fly.probes]).toEqual([1, 1, 1, 1]);
  });

  it('prefers real isolation over the guardrail floor whenever it can', async () => {
    const m = manager([
      new FakeProvider('local', 10, { available: true, isolated: false }),
      new FakeProvider('podman', 18, up(true)),
    ]);
    expect((await m.resolveProvider('auto')).name).toBe('podman');
  });

  it('honours an explicit provider and never silently substitutes a weaker one', async () => {
    const m = manager([
      new FakeProvider('docker', 20, down('daemon is not running', 'start Docker Desktop')),
      new FakeProvider('local', 10, { available: true, isolated: false }),
    ]);
    await expect(m.resolveProvider('docker')).rejects.toMatchObject({
      code: 'E_PROVIDER_UNAVAILABLE',
      hint: 'start Docker Desktop',
    });
  });

  it('lists what it knows when asked for a provider that does not exist', async () => {
    const m = manager([new FakeProvider('local', 10, up(false))]);
    await expect(m.resolveProvider('kubernetes')).rejects.toMatchObject({
      code: 'E_PROVIDER_UNAVAILABLE',
      hint: 'known providers: local',
    });
  });

  it('collects every rejection when nothing is usable', async () => {
    const m = manager([
      new FakeProvider('docker', 20, down('daemon is not running', 'start it')),
      new FakeProvider('fly', 14, down('no token', 'fly auth token')),
    ]);
    await expect(m.resolveProvider('auto')).rejects.toMatchObject({
      code: 'E_PROVIDER_UNAVAILABLE',
      details: { rejected: ['docker: daemon is not running', 'fly: no token'] },
    });
  });
});

describe('probe', () => {
  it('caches an answer, because probes are slow and agents are chatty', async () => {
    const p = new FakeProvider('docker', 20, up(true));
    const m = manager([p]);
    await m.probe('docker');
    await m.probe('docker');
    expect(p.probes).toBe(1);
  });

  it('re-probes on demand, so `husk doctor --force` means something', async () => {
    const p = new FakeProvider('docker', 20, up(true));
    const m = manager([p]);
    await m.probe('docker');
    await m.probe('docker', true);
    expect(p.probes).toBe(2);
  });

  it('expires the cache after the ttl', async () => {
    const p = new FakeProvider('docker', 20, up(true));
    const m = new ComputerManager({ providers: [p], probeTtlMs: 0, logger: silent });
    await m.probe('docker');
    await m.probe('docker');
    expect(p.probes).toBe(2);
  });

  it('turns a provider that throws into an unavailable row, not a crash', async () => {
    const m = manager([
      new FakeProvider('broken', 20, async () => {
        throw new Error('podman exploded');
      }),
      new FakeProvider('local', 10, up(false)),
    ]);
    const a = await m.probe('broken');
    expect(a.available).toBe(false);
    expect(a.reason).toContain('podman exploded');
    // And it must not take selection down with it.
    expect((await m.resolveProvider('auto')).name).toBe('local');
  });

  it('answers for a provider that was never registered', async () => {
    const a = await manager([]).probe('fly');
    expect(a).toMatchObject({ available: false, reason: 'no provider named fly' });
  });
});

describe('status', () => {
  it('returns one row per provider, highest priority first, with the reason attached', async () => {
    const m = manager([
      new FakeProvider('local', 10, { available: true, isolated: false, reason: 'guardrails, not a sandbox' }),
      new FakeProvider('docker', 20, down('daemon is not running', 'start Docker Desktop')),
    ]);
    const rows = await m.status();
    expect(rows.map((r) => r.name)).toEqual(['docker', 'local']);
    expect(rows[0]).toMatchObject({ available: false, hint: 'start Docker Desktop', priority: 20 });
    expect(rows[1]).toMatchObject({ available: true, isolated: false, reason: 'guardrails, not a sandbox' });
  });
});

/**
 * Cleanup is non-transactional in both directions, and both directions used to
 * be invisible: a registry record could outlive its workspace (an undeletable
 * zombie that `husk ps` listed and no command could touch) and a workspace
 * could outlive its record (real files no command could see).
 */
describe('stale bookkeeping', () => {
  /**
   * Shaped like `LocalProvider`: `list()` reads the JSON records, `get()`
   * returns null once the backing workspace is gone. That asymmetry is the
   * whole bug -- the computer is listed and unreachable at the same time.
   */
  class RegistryBackedProvider extends FakeProvider {
    constructor() {
      super('local', 10, { available: true, isolated: false });
    }

    override async list(): Promise<ComputerInfo[]> {
      return (await loadInfos('local')).filter((i) => i.state !== 'destroyed');
    }
  }

  async function withHome<T>(fn: (home: string, m: ComputerManager) => Promise<T>): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), 'husk-home-'));
    const previous = process.env.HUSK_HOME;
    process.env.HUSK_HOME = home;
    try {
      await mkdir(join(home, 'computers'), { recursive: true });
      await mkdir(join(home, 'workspaces'), { recursive: true });
      return await fn(home, manager([new RegistryBackedProvider()]));
    } finally {
      if (previous === undefined) delete process.env.HUSK_HOME;
      else process.env.HUSK_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  }

  async function writeRecord(home: string, id: string, extra: Partial<ComputerInfo> = {}): Promise<void> {
    const now = new Date().toISOString();
    const info: ComputerInfo = {
      id,
      name: id,
      provider: 'local',
      state: 'running',
      image: 'local:wsl',
      workdir: '/work',
      createdAt: now,
      lastUsedAt: now,
      spec: {},
      ...extra,
    } as ComputerInfo;
    await writeFile(join(home, 'computers', `${id}.json`), JSON.stringify(info), 'utf8');
  }

  it('destroy() clears a record whose machine is gone, instead of reporting failure', async () => {
    await withHome(async (home, m) => {
      // No provider can produce this machine -- exactly the state a deleted
      // workspace leaves behind.
      await writeRecord(home, 'cmp_zombie');
      expect(await m.destroy('cmp_zombie')).toBe(true);
      expect(existsSync(join(home, 'computers', 'cmp_zombie.json'))).toBe(false);
    });
  });

  it('destroy() still reports false for an id that was never known', async () => {
    await withHome(async (_home, m) => {
      expect(await m.destroy('cmp_nosuchthing')).toBe(false);
    });
  });

  it('destroyAll() counts the stale records it cleared, so the total is not a lie', async () => {
    await withHome(async (home, m) => {
      await writeRecord(home, 'cmp_one');
      await writeRecord(home, 'cmp_two');
      // The bug: "destroying 2 computers" followed by "destroyed 0", exit zero.
      expect(await m.destroyAll()).toBe(2);
      expect(await m.list()).toEqual([]);
    });
  });

  it('destroy() releases the binding a stale record was holding', async () => {
    await withHome(async (home, m) => {
      await writeRecord(home, 'cmp_bound', { spec: { labels: { 'husk.key': 'mcp:abc' } } });
      await writeFile(join(home, 'computers', 'bindings.json'), JSON.stringify({ 'mcp:abc': 'cmp_bound' }), 'utf8');
      expect(await m.destroy('cmp_bound')).toBe(true);
      const bindings = JSON.parse(await readFile(join(home, 'computers', 'bindings.json'), 'utf8'));
      expect(bindings.bindings?.['mcp:abc'] ?? bindings['mcp:abc']).toBeUndefined();
    });
  });

  it('finds workspace directories with no registry record', async () => {
    await withHome(async (home, m) => {
      await mkdir(join(home, 'workspaces', 'cmp_orphan', 'root'), { recursive: true });
      await mkdir(join(home, 'workspaces', 'cmp_kept'), { recursive: true });
      await writeRecord(home, 'cmp_kept');

      expect(await m.orphanWorkspaces()).toEqual([join(home, 'workspaces', 'cmp_orphan')]);
      expect(await m.pruneOrphanWorkspaces()).toBe(1);
      expect(existsSync(join(home, 'workspaces', 'cmp_orphan'))).toBe(false);
      // The one with a record is still someone's machine. Never touched.
      expect(existsSync(join(home, 'workspaces', 'cmp_kept'))).toBe(true);
    });
  });
});

/**
 * Binding is how a session finds its filesystem again, so the key is the unit
 * of sharing -- and sharing a key means sharing a `/work`. Before refcounting,
 * two holders of one key could not be distinguished, so whichever disconnected
 * first destroyed the other's machine.
 */
describe('binding refcounts', () => {
  class OneComputerProvider extends FakeProvider {
    readonly created: FakeComputer[] = [];

    constructor() {
      super('local', 10, { available: true, isolated: false });
    }

    override async create(spec: ComputerSpec): Promise<Computer> {
      const c = new FakeComputer(`cmp_fake${this.created.length}`, spec);
      this.created.push(c);
      await persistInfo(c.info);
      return c as unknown as Computer;
    }

    override async get(id: string): Promise<Computer | null> {
      const hit = this.created.find((c) => (c.id === id || c.info.name === id) && !c.destroyed);
      return (hit as unknown as Computer) ?? null;
    }

    override async list(): Promise<ComputerInfo[]> {
      return this.created.filter((c) => !c.destroyed).map((c) => c.info);
    }
  }

  class FakeComputer {
    destroyed = false;
    readonly info: ComputerInfo;

    constructor(
      readonly id: string,
      spec: ComputerSpec,
    ) {
      const now = new Date().toISOString();
      this.info = {
        id,
        name: spec.name ?? id,
        provider: 'local',
        state: 'running',
        image: 'fake',
        workdir: '/work',
        createdAt: now,
        lastUsedAt: now,
        spec,
      } as ComputerInfo;
    }

    async destroy(): Promise<void> {
      this.destroyed = true;
      this.info.state = 'destroyed';
    }
  }

  async function withHome<T>(fn: (make: () => ComputerManager, provider: OneComputerProvider) => Promise<T>) {
    const home = await mkdtemp(join(tmpdir(), 'husk-home-'));
    const previous = process.env.HUSK_HOME;
    process.env.HUSK_HOME = home;
    try {
      await mkdir(join(home, 'computers'), { recursive: true });
      await mkdir(join(home, 'workspaces'), { recursive: true });
      // One shared provider, several managers: that is the shape of two
      // independent sessions on one machine.
      const provider = new OneComputerProvider();
      return await fn(() => manager([provider]), provider);
    } finally {
      if (previous === undefined) delete process.env.HUSK_HOME;
      else process.env.HUSK_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  }

  it('gives two different keys two different computers', async () => {
    await withHome(async (make) => {
      const m = make();
      const a = await m.ensure('mcp:session-a');
      const b = await m.ensure('mcp:session-b');
      // The whole point of keying on the session: separate /work.
      expect(a.id).not.toBe(b.id);
    });
  });

  it('gives the same key the same computer across calls', async () => {
    await withHome(async (make) => {
      const m = make();
      expect((await m.ensure('mcp:session-a')).id).toBe((await m.ensure('mcp:session-a')).id);
    });
  });

  it('counts one holder per manager, not one per ensure() call', async () => {
    await withHome(async (make) => {
      const m = make();
      await m.ensure('shared');
      await m.ensure('shared');
      await m.ensure('shared');
      expect((await listBindings()).shared?.refs).toBe(1);
    });
  });

  it('counts two sessions sharing a key as two holders', async () => {
    await withHome(async (make) => {
      await make().ensure('shared');
      await make().ensure('shared');
      expect((await listBindings()).shared?.refs).toBe(2);
    });
  });

  it('does not destroy a shared computer when one of two sessions leaves', async () => {
    await withHome(async (make, provider) => {
      const first = make();
      const second = make();
      await first.ensure('shared');
      await second.ensure('shared');

      // This is the bug: the first session to disconnect used to take the
      // filesystem with it while the second was still running.
      expect(await first.release('shared', { destroy: true })).toBe(false);
      expect(provider.created[0]?.destroyed).toBe(false);
      expect((await listBindings()).shared?.refs).toBe(1);
    });
  });

  it('destroys it when the last holder leaves', async () => {
    await withHome(async (make, provider) => {
      const first = make();
      const second = make();
      await first.ensure('shared');
      await second.ensure('shared');

      await first.release('shared', { destroy: true });
      expect(await second.release('shared', { destroy: true })).toBe(true);
      expect(provider.created[0]?.destroyed).toBe(true);
      expect((await listBindings()).shared).toBeUndefined();
    });
  });

  it('keeps the computer when the holder asked not to destroy it', async () => {
    await withHome(async (make, provider) => {
      const m = make();
      await m.ensure('kept');
      expect(await m.release('kept', { destroy: false })).toBe(false);
      expect(provider.created[0]?.destroyed).toBe(false);
    });
  });

  it('ignores a release from a manager that never held the key', async () => {
    await withHome(async (make) => {
      await make().ensure('shared');
      expect(await make().release('shared', { destroy: true })).toBe(false);
      expect((await listBindings()).shared?.refs).toBe(1);
    });
  });

  it('reads a pre-refcount bindings file as one holder rather than orphaning it', async () => {
    await withHome(async (make, provider) => {
      const m = make();
      const c = await m.ensure('legacy');
      // Rewrite the file in the old flat `key -> id` format, as an older husk
      // would have left it.
      await writeFile(
        join(process.env.HUSK_HOME as string, 'computers', 'bindings.json'),
        JSON.stringify({ legacy: c.id }),
        'utf8',
      );

      const other = make();
      expect((await other.ensure('legacy')).id).toBe(c.id);
      // One migrated holder plus the new one.
      expect((await listBindings()).legacy?.refs).toBe(2);
      expect(provider.created).toHaveLength(1);
    });
  });
});
