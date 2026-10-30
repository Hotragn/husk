import { createLogger, parseSpec } from '@husk-ai/core';
import { describe, expect, it } from 'vitest';
import { Agent, computerSpecFor } from './loop.js';
import { FakeComputerSource, FakeRouter, toolCall } from './test-support.js';
import { defineTool, type AgentRunEvent, type AgentTool } from './types.js';

const silent = createLogger({ level: 'silent' });

/**
 * The husk.yaml -> ComputerSpec hop.
 *
 * `computer.labels` is the only way a single husk.yaml can name the box or the
 * Fly app it wants, and it is worthless if the loop drops it on the way to the
 * provider. Both halves are asserted: the translation itself, and that the loop
 * really hands the translation to the computer source.
 */
describe('computerSpecFor', () => {
  it('carries labels and user through from the parsed husk.yaml', () => {
    const spec = parseSpec({
      name: 'deployer',
      computer: {
        provider: 'ssh',
        user: 'deploy',
        labels: { 'husk.ssh': 'deploy@build-box:2222' },
      },
    });
    const cspec = computerSpecFor(spec);
    expect(cspec.labels).toEqual({ 'husk.ssh': 'deploy@build-box:2222' });
    expect(cspec.user).toBe('deploy');
    expect(cspec.provider).toBe('ssh');
    expect(cspec.name).toBe('deployer');
  });

  it('leaves both undefined when the husk.yaml is silent about them', () => {
    const cspec = computerSpecFor(parseSpec({ name: 'plain' }));
    expect(cspec.labels).toBeUndefined();
    expect(cspec.user).toBeUndefined();
  });

  it('reads ${NAME} in computer.env where Husk runs, and refuses one that is not set', () => {
    const spec = parseSpec({
      name: 'ci',
      computer: { env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', URL: 'https://${HOST}/x', PS1: '$${debian_chroot}' } },
    });
    expect(computerSpecFor(spec, { GITHUB_TOKEN: 'ghp_x', HOST: 'example.com' }).env).toEqual({
      GITHUB_TOKEN: 'ghp_x',
      URL: 'https://example.com/x',
      PS1: '${debian_chroot}',
    });
    // The placeholder stays in the spec itself, for whatever writes it back to disk.
    expect(spec.computer.env.GITHUB_TOKEN).toBe('${GITHUB_TOKEN}');
    expect(() => computerSpecFor(spec, { HOST: 'example.com' })).toThrow(/computer\.env\.GITHUB_TOKEN uses \$\{GITHUB_TOKEN\}, which is not set/);
    expect(() => computerSpecFor(spec, { GITHUB_TOKEN: '', HOST: 'example.com' })).toThrow(/which is empty/);
  });

  it('hands the guardrails lists to the computer as labels, keeping its own', () => {
    const spec = parseSpec({
      name: 'ops',
      guardrails: { allowCommands: ['^sudo apt-get install'], denyCommands: ['terraform\\s+apply'] },
      computer: { labels: { team: 'infra' } },
    });
    expect(computerSpecFor(spec).labels).toEqual({
      team: 'infra',
      'husk.allowCommands': '["^sudo apt-get install"]',
      'husk.denyCommands': '["terraform\\\\s+apply"]',
    });
  });
});

describe('Agent: the spec it asks the computer source for', () => {
  it('passes the husk.yaml labels down to ensure()', async () => {
    const computers = new FakeComputerSource();
    const needsBox: AgentTool = defineTool<Record<string, never>, string>({
      name: 'box',
      description: 'uses the machine',
      needsComputer: true,
      parameters: { type: 'object', properties: {} },
      async handler(_i, ctx) {
        return (await ctx.acquireComputer()).id;
      },
    });
    const spec = parseSpec({
      name: 'deployer',
      computer: { provider: 'ssh', user: 'deploy', labels: { 'husk.ssh': 'deploy@build-box:2222' } },
    });

    const agent = new Agent({
      spec,
      router: new FakeRouter([{ toolCalls: [toolCall('a', 'box')] }, { text: 'done' }]),
      computers,
      tools: [needsBox] as never,
      logger: silent,
    });

    const events: AgentRunEvent[] = [];
    for await (const e of agent.stream({ input: 'go' })) events.push(e);

    expect(computers.calls).toBe(1);
    expect(computers.specs[0]?.labels).toEqual({ 'husk.ssh': 'deploy@build-box:2222' });
    expect(computers.specs[0]?.user).toBe('deploy');
  });
});
