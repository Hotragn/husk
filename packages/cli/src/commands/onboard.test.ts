/**
 * What onboarding says, with nothing real behind it.
 *
 * The probes are injected the way `doctor`'s are, so these run in milliseconds
 * and assert the thing that actually matters about this command: not that it
 * renders, but that the *sentences* are the ones the security docs commit to.
 *
 * Two of them are load-bearing. An onboarding is the screen where someone forms
 * their belief about the isolation boundary, so softening "not a sandbox" here
 * would quietly undo the four documents that were corrected to say it. And an
 * onboarding that offered to hold an API key would make
 * `SECURITY-MODEL.md`'s "never writes them to ~/.husk" false on the very first
 * run -- so the absence of a key prompt is a test, not a style preference.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorProbes } from './doctor.js';
import { run } from './onboard.js';

let home: string;
const original = process.env.HUSK_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'husk-onboard-'));
  process.env.HUSK_HOME = home;
});

afterEach(async () => {
  if (original === undefined) delete process.env.HUSK_HOME;
  else process.env.HUSK_HOME = original;
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
  vi.restoreAllMocks();
});

/** A machine with the unisolated provider and no model at all: the hard case. */
const bare: DoctorProbes = {
  providerStatus: async () => [
    {
      name: 'local',
      description: 'a guarded working directory on this machine',
      priority: 10,
      available: true,
      isolated: false,
      isolationKind: 'guardrails',
      version: 'WSL2 (Ubuntu)',
    },
    {
      name: 'docker',
      description: 'a container per computer',
      priority: 50,
      available: false,
      isolated: true,
      isolationKind: 'kernel',
      reason: 'the docker daemon is not reachable',
      hint: 'start Docker Desktop',
    },
  ],
  // Real providers that husk implements, with nothing configured. This is the
  // case onboarding exists for, and `implemented: false` is not it -- a
  // provider husk cannot use must not be suggested, so a fixture of unbuilt
  // providers would test the wrong branch.
  modelProviders: async () =>
    [
      { id: 'anthropic', isAvailable: async () => ({ available: false, reason: 'ANTHROPIC_API_KEY is not set' }), listModels: async () => [] },
      { id: 'openai', isAvailable: async () => ({ available: false, reason: 'OPENAI_API_KEY is not set' }), listModels: async () => [] },
      { id: 'ollama', isAvailable: async () => ({ available: false, reason: 'nothing is listening on 127.0.0.1:11434' }), listModels: async () => [] },
    ] as unknown as Awaited<ReturnType<DoctorProbes['modelProviders']>>,
  orphanedWorkspaces: async () => [],
  windowsDegradation: async () => null,
};

/** Nothing works at all. */
const empty: DoctorProbes = {
  ...bare,
  providerStatus: async () => [
    {
      name: 'docker',
      description: 'a container per computer',
      priority: 50,
      available: false,
      isolated: true,
      isolationKind: 'kernel',
      reason: 'the docker daemon is not reachable',
      hint: 'start Docker Desktop',
    },
  ],
};

async function capture(argv: string[], probes: DoctorProbes): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const grab = (c: unknown): boolean => {
    chunks.push(String(c));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
  const code = await run(argv, probes);
  return { code, out: chunks.join('') };
}

describe('husk onboard', () => {
  it('walks five steps and ends with one command to run', async () => {
    const { code, out } = await capture(['--skip-checks'], bare);
    expect(code).toBe(0);
    for (const n of [1, 2, 3, 4, 5]) expect(out).toContain(`[${n}/5]`);
    expect(out).toContain('husk doctor');
  });

  it('calls an unisolated provider what the security docs call it', async () => {
    const { out } = await capture(['--skip-checks'], bare);
    expect(out).toContain('guardrails only');
    expect(out).toContain('not a sandbox');
    // And it points at the stronger thing rather than leaving them there.
    expect(out).toContain('start Docker Desktop');
  });

  it('never offers to take an API key', async () => {
    const { out } = await capture(['--skip-checks'], bare);
    // The whole point of step 3: name the variable, do not ask for its value.
    expect(out).toContain('export ');
    expect(out).toContain('never stores it');
    expect(out.toLowerCase()).not.toContain('paste');
    expect(out.toLowerCase()).not.toContain('enter your key');
  });

  it('offers the free local model before any of the paid ones', async () => {
    const { out } = await capture(['--skip-checks'], bare);
    expect(out.indexOf('ollama pull')).toBeGreaterThan(-1);
    expect(out.indexOf('ollama pull')).toBeLessThan(out.indexOf('export '));
  });

  it('creates nothing when there is no terminal and no --yes', async () => {
    const { out } = await capture([], bare);
    expect(out).toContain('no terminal here, so nothing was created');
  });

  it('sends someone with no usable provider to doctor, not to a dead end', async () => {
    const { out } = await capture(['--skip-checks'], empty);
    expect(out).toContain('no usable provider');
    expect(out).toContain('start Docker Desktop');
  });

  it('prints an MCP config a client can actually consume', async () => {
    const { out } = await capture(['--skip-checks'], bare);
    expect(out).toContain('claude mcp add husk -- npx -y @husk-ai/mcp');
    const inline = out.match(/\{"mcpServers".*?\}\}\}/)?.[0];
    expect(inline, 'the JSON form should be present and parseable').toBeTruthy();
    expect(JSON.parse(inline as string)).toEqual({
      mcpServers: { husk: { command: 'npx', args: ['-y', '@husk-ai/mcp'] } },
    });
  });

  it('answers --json with a plan and nothing else on stdout', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const code = await run(['--json'], bare);
    expect(code).toBe(0);
    const plan = JSON.parse(chunks.join(''));
    expect(plan.provider).toBe('local');
    expect(plan.isolated).toBe(false);
    expect(plan.model).toBeNull();
    expect(plan.next).toBe('husk up scratch');
    expect(plan.mcp).toEqual({ command: 'npx', args: ['-y', '@husk-ai/mcp'] });
  });

  it('is safe to re-run', async () => {
    const first = await capture(['--skip-checks'], bare);
    const second = await capture(['--skip-checks'], bare);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.out).toContain('[1/5]');
  });
});
