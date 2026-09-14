import { describe, expect, it } from 'vitest';
import { createLogger } from '@husk/core';
import type { Availability, Computer, ComputerInfo, ComputerProvider, ComputerSpec } from '@husk/core';
import { ComputerManager, defaultProviders } from './manager.js';

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

  async get(): Promise<Computer | null> {
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
