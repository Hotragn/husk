import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expired, forgetInfo, lastUsedTimes, reapExpired, touchInfo } from './registry.js';
import { onComputerDestroyed } from '@husk-ai/core';
import type { Computer, ComputerInfo } from '@husk-ai/core';

/**
 * The last-use record, and the budget arithmetic that acts on it.
 *
 * Docker and Podman answer "what exists?" from their own labels, so nothing
 * else about them is written to disk. But no engine records when husk last ran
 * a command in a container -- `docker inspect` offers `State.StartedAt`, which
 * is when it booted -- and reaping on that is not a weaker idle timeout, it is
 * a container destroyed in the middle of a long build.
 */

let home: string | undefined;
const original = process.env.HUSK_HOME;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
  if (original === undefined) delete process.env.HUSK_HOME;
  else process.env.HUSK_HOME = original;
});

async function freshHome() {
  home = await mkdtemp(join(tmpdir(), 'husk-registry-'));
  process.env.HUSK_HOME = home;
  await mkdir(join(home, 'computers'), { recursive: true });
  return home;
}

const info = (over: Partial<ComputerInfo> = {}): ComputerInfo => ({
  id: 'cmp_a',
  name: 'a',
  provider: 'docker',
  state: 'running',
  image: 'husk-base',
  workdir: '/work',
  createdAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
  spec: { provider: 'docker' },
  ...over,
});

describe('the last-use record', () => {
  it('reads back what was written', async () => {
    await freshHome();
    const at = new Date('2026-09-16T12:00:00.000Z');
    await touchInfo('cmp_a', at);
    expect((await lastUsedTimes()).get('cmp_a')).toBe(at.toISOString());
  });

  it('is empty rather than throwing when nothing has been recorded', async () => {
    await freshHome();
    expect((await lastUsedTimes()).size).toBe(0);
  });

  it('ignores an unparseable timestamp instead of reporting an epoch', async () => {
    // A garbage file must not read as 1970, which would make the container
    // look maximally idle and get it destroyed.
    const h = await freshHome();
    await writeFile(join(h, 'computers', 'cmp_a.used'), 'not a date', 'utf8');
    expect((await lastUsedTimes()).has('cmp_a')).toBe(false);
  });

  it('does not confuse a record with a persisted info file', async () => {
    const h = await freshHome();
    await writeFile(join(h, 'computers', 'cmp_b.json'), '{}', 'utf8');
    await touchInfo('cmp_a');
    const times = await lastUsedTimes();
    expect([...times.keys()]).toEqual(['cmp_a']);
  });

  it('goes away with the computer', async () => {
    await freshHome();
    await touchInfo('cmp_a');
    await forgetInfo('cmp_a');
    expect((await lastUsedTimes()).size).toBe(0);
  });
});

describe('the budget arithmetic reap depends on', () => {
  const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

  it('keeps a container that is busy, however long it has been up', () => {
    // The case that makes StartedAt the wrong clock: up for an hour, used a
    // second ago, under a ten-minute idle budget.
    const busy = info({ createdAt: ago(3600), lastUsedAt: ago(1), spec: { provider: 'docker', idleTimeoutSec: 600 } });
    expect(expired([busy])).toEqual([]);
  });

  it('removes one that has been idle past its budget', () => {
    const idle = info({ createdAt: ago(3600), lastUsedAt: ago(700), spec: { provider: 'docker', idleTimeoutSec: 600 } });
    expect(expired([idle]).map((i) => i.id)).toEqual(['cmp_a']);
  });

  it('removes one past its lifetime even while it is busy', () => {
    const old = info({ createdAt: ago(7200), lastUsedAt: ago(1), spec: { provider: 'docker', maxLifetimeSec: 3600 } });
    expect(expired([old]).map((i) => i.id)).toEqual(['cmp_a']);
  });

  it('leaves a computer with no budget alone forever', () => {
    // Zero and absent both mean "no ceiling". Treating them as an immediate
    // deadline would destroy every computer on the first sweep.
    const forever = info({ createdAt: ago(99999), lastUsedAt: ago(99999) });
    expect(expired([forever])).toEqual([]);
    expect(expired([info({ spec: { provider: 'docker', idleTimeoutSec: 0, maxLifetimeSec: 0 } })])).toEqual([]);
  });
});

describe('reaping', () => {
  const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

  it("closes each expired computer's browser before the machine goes, and keeps sweeping past one that will not go", async () => {
    const order: string[] = [];
    const off = onComputerDestroyed((id) => {
      order.push(`browser ${id}`);
    });
    const idle = (id: string) => info({ id, createdAt: ago(3600), lastUsedAt: ago(700), spec: { provider: 'docker', idleTimeoutSec: 600 } });
    const provider = {
      list: async () => [idle('cmp_stuck'), idle('cmp_old'), info({ id: 'cmp_busy', lastUsedAt: ago(1), spec: { provider: 'docker', idleTimeoutSec: 600 } })],
      get: async (id: string) =>
        ({
          destroy: async () => {
            if (id === 'cmp_stuck') throw new Error('device or resource busy');
            order.push(`destroy ${id}`);
          },
        }) as unknown as Computer,
    };
    try {
      // The browser's close runs a pkill inside the computer, so it has to come first.
      expect(await reapExpired(provider)).toEqual(['cmp_old']);
      expect(order).toEqual(['browser cmp_stuck', 'browser cmp_old', 'destroy cmp_old']);
    } finally {
      off();
    }
  });
});
