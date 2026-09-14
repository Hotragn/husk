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
