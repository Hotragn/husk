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
import { belowNodeFloor, collect } from './doctor.js';
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
      // The label the real provider emits. The fixture used to say
      // `wsl:Ubuntu`, a format nothing produces, which is part of why the
      // Windows warning could be dead for as long as it was.
      version: 'WSL2 (Ubuntu)',
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
  windowsDegradation: async () => null,
};

/** The same machine, with WSL in one of the two states that break it. */
const onWindows = (degradation: 'wsl-broken' | 'wsl-absent'): DoctorProbes => ({
  ...probes,
  windowsDegradation: async () => degradation,
});

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

  it('says nothing about WSL when the host is not a degraded Windows one', async () => {
    const report = await collect(false, probes);
    expect(report.warnings.join(' ')).not.toMatch(/WSL/);
  });

  it('warns that a Windows host is not a Linux computer', async () => {
    // This assertion is the point of the change. The warning it covers was
    // guarded by `!/wsl/i.test(version)`, and every label that field can hold
    // contains "WSL" -- including both of the ones that describe the broken
    // state -- so it had never printed for anyone.
    for (const state of ['wsl-broken', 'wsl-absent'] as const) {
      const report = await collect(false, onWindows(state));
      expect(report.warnings.join(' ')).toMatch(/not a Linux computer/);
    }
  });

  it('does not tell someone to install the WSL they already have', async () => {
    const broken = await collect(false, onWindows('wsl-broken'));
    expect(broken.warnings.join(' ')).toMatch(/wsl --shutdown/);
    expect(broken.warnings.join(' ')).not.toMatch(/wsl --install/);

    const absent = await collect(false, onWindows('wsl-absent'));
    expect(absent.warnings.join(' ')).toMatch(/wsl --install/);
    expect(absent.warnings.join(' ')).not.toMatch(/wsl --shutdown/);
  });

  it('names WSL as the one reason both the shell and docker are gone', async () => {
    // The fixture's docker is down. On Windows that is not a coincidence --
    // its engine runs inside WSL2 -- and two unrelated-looking failures send
    // someone chasing Docker Desktop when the fix is upstream of both.
    const report = await collect(false, onWindows('wsl-broken'));
    expect(report.warnings.join(' ')).toMatch(/engine runs inside WSL2/);
  });

  it('warns below Node 20.10, as engines says, and not only below 20', () => {
    expect(['18.20.4', '20.0.0', '20.9.0'].map(belowNodeFloor)).toEqual([true, true, true]);
    expect(['20.10.0', '20.19.1', '22.3.0', '24.0.0'].map(belowNodeFloor)).toEqual([false, false, false, false]);
  });
});
