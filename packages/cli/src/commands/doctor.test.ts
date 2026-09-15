/**
 * How doctor reports, with nothing real behind it.
 *
 * The assertions here used to live in `smoke.test.ts`, where they ran the real
 * binary against the real machine: docker, podman and wsl probed over a
 * subprocess. That test asserted only the *shape* of the report, so every
 * second it spent waiting on an external binary bought nothing -- and on a
 * loaded machine it took 890 seconds and failed. Fakes make it deterministic
 * and instant.
 */
import { describe, expect, it } from 'vitest';
import { collect } from './doctor.js';
import type { DoctorProbes } from './doctor.js';

/** One provider that works without isolation, one that is installed but down. */
const probes: DoctorProbes = {
  providerStatus: async () => [
    {
      name: 'local',
      description: 'a guarded working directory on this machine',
      priority: 10,
      available: true,
      isolated: false,
      isolationKind: 'guardrails',
      version: 'wsl:Ubuntu',
    },
    {
      name: 'docker',
      description: 'a container per computer',
      priority: 50,
      available: false,
      isolated: true,
      isolationKind: 'kernel',
      reason: 'docker is installed but the daemon is not reachable',
      hint: 'start Docker Desktop',
    },
  ],
  modelProviders: async () => [],
  orphanedWorkspaces: async () => [],
};

describe('doctor', () => {
  it('names a provider, its isolation, and what husk would pick', async () => {
    const report = await collect(false, probes);

    expect(report.providers.length).toBeGreaterThan(0);
    for (const p of report.providers) {
      expect(p).toHaveProperty('available');
      expect(p).toHaveProperty('isolated');
      // Anything unavailable must say why and what to do about it.
      if (!p.available) expect(p.reason ?? p.hint).toBeTruthy();
    }
    expect(report.selection).toHaveProperty('provider');
  });

  it('picks the highest-priority available provider, not the best one', async () => {
    const report = await collect(false, probes);
    // docker outranks local, but docker is down.
    expect(report.selection.provider).toBe('local');
    expect(report.selection.isolated).toBe(false);
  });

  it('surfaces weak isolation as a warning rather than a field', async () => {
    const report = await collect(false, probes);
    expect(report.warnings.join(' ')).toMatch(/guardrails, not isolation/);
  });

  it('says a stopped docker daemon is why isolation got weaker', async () => {
    const report = await collect(false, probes);
    expect(report.warnings.join(' ')).toMatch(/daemon is not running/);
  });

  it('does not tell someone with no model to go pull one', async () => {
    const report = await collect(false, probes);
    // The largest group of users never needs a model: husk mcp supplies the
    // computer and the MCP client brings its own.
    expect(report.warnings.join(' ')).toMatch(/husk mcp` needs no model/);
  });
});
