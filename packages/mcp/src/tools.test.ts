/**
 * Every tool husk advertises must be one it will actually run.
 *
 * This is the third time the same shape of bug has been found: a tool exists,
 * works, is tested, and is invisible to one caller because a list somewhere was
 * not updated. `listBuiltinTools()` in `@husk-ai/agent` was missing six. This
 * package was missing all five browser tools, which meant the MCP client -- the
 * integration husk exists for -- was the only caller that could not open a page
 * in the browser running inside its own computer.
 *
 * So: assert the list and the dispatcher agree, in both directions.
 */

import { describe, expect, it } from 'vitest';
import { TOOLS, callTool } from './tools.js';
import { BROWSER_TOOLS, MAX_WAIT_SEC, secondsArg } from './browser-tools.js';
import type { Computer } from '@husk-ai/core';
import { PROBE_COMPUTER_INFO } from '@husk-ai/core';
import { STOP_UNCONFIRMED } from '@husk-ai/runtime';

/** Never reached: every assertion here stops at the dispatcher. */
const noComputer = {} as Computer;

describe('the MCP tool list', () => {
  it('advertises the browser', () => {
    const names = TOOLS.map((t) => t.name);
    for (const tool of ['browser_goto', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_status']) {
      expect(names).toContain(tool);
    }
  });

  it('turns a bad browser_run into a message before any browser is touched', async () => {
    const say = async (args: Record<string, unknown>) =>
      (await callTool(noComputer, 'browser_run', args)).content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(await say({})).toMatch(/non-empty list/);
    expect(await say({ actions: [{ do: 'eval', code: 'alert(1)' }] })).toMatch(/action 1: do must be one of/);
    expect(await say({ actions: [{ do: 'snapshot' }, { do: 'click' }] })).toMatch(/action 2: say which element/);
    expect(await say({ actions: [{ do: 'wait' }] })).toMatch(/wait needs text, url or selector/);
  });

  it('turns an empty or oversized browser_script into a message before any browser is touched', async () => {
    const say = async (args: Record<string, unknown>) =>
      (await callTool(noComputer, 'browser_script', args)).content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(await say({})).toMatch(/script is empty/);
    expect(await say({ script: 'x'.repeat(100_001) })).toMatch(/over 100 KB/);
  });

  it('advertises the whole browser module, not a subset someone remembered', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const tool of BROWSER_TOOLS) expect(names).toContain(tool.name);
  });

  it('has no duplicate names', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a description and an object schema', () => {
    // A model picks tools by description alone. An empty one is a tool that
    // will not be called, which is the same outcome as not shipping it.
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
  });

  it('routes every advertised tool somewhere', async () => {
    // "unknown tool" is the failure this catches: a name in the list with no
    // case in the switch. Any other error means it was routed and then failed
    // for want of a real computer, which is what should happen here.
    for (const tool of TOOLS) {
      const result = await callTool(noComputer, tool.name, {});
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text, tool.name).not.toMatch(/unknown tool/);
      expect(text, tool.name).not.toMatch(/unknown browser tool/);
    }
  });

  it('still reports a genuinely unknown name as unknown', () => {
    // The guard above is only worth anything if this still fails.
    return expect(callTool(noComputer, 'browser_teleport', {})).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/unknown tool/) }],
    });
  });

  it('rejects an empty ref before touching the browser', async () => {
    // Argument validation must not depend on a live Chromium, or a typo costs
    // a 111 MB download to discover.
    const result = await callTool(noComputer, 'browser_click', { ref: '  ' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'ref is empty' });
  });

  it('rejects an empty url before touching the browser', async () => {
    const result = await callTool(noComputer, 'browser_goto', { url: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'url is empty' });
  });
});

/**
 * Same tool name, same facts, whichever entry point the caller arrived through.
 *
 * `computer_info` used to answer differently here and in `@husk-ai/agent`: this
 * copy probed for installed tools and the agent's did not. Nothing surfaced the
 * difference, so a model that learned the shape from one saw less from the other.
 */
describe('computer_info', () => {
  function recording(): { computer: Computer; cmds: string[] } {
    const cmds: string[] = [];
    const computer = {
      info: { id: 'cmp_test', provider: 'docker', image: 'debian:bookworm-slim' },
      exec: async (req: { cmd: string }) => {
        cmds.push(req.cmd);
        return { exitCode: 0, stdout: 'probed', stderr: '', durationMs: 1 };
      },
    } as unknown as Computer;
    return { computer, cmds };
  }

  it('runs the same probe the agent runs', async () => {
    const { computer, cmds } = recording();
    await callTool(computer, 'computer_info', {});

    expect(typeof PROBE_COMPUTER_INFO).toBe('string');
    expect(cmds[0]).toContain(PROBE_COMPUTER_INFO);
  });

  it('still prefers huskinfo when the image ships it', async () => {
    const { computer, cmds } = recording();
    await callTool(computer, 'computer_info', {});

    expect(cmds[0]).toMatch(/^command -v huskinfo .* && huskinfo \|\| \{ /);
  });

  it('closes the brace group it opens', async () => {
    // `|| { ... }` needs the trailing `; }`. Getting this wrong is a syntax
    // error that only appears on a real machine, never in a type check.
    const { computer, cmds } = recording();
    await callTool(computer, 'computer_info', {});

    expect(cmds[0]?.endsWith('; }')).toBe(true);
  });

  it('reports a failed probe instead of a healthy-looking header', async () => {
    const { computer } = recording();
    computer.exec = async () => ({ exitCode: 1, stdout: '', stderr: 'container is not running', durationMs: 1, timedOut: false, truncated: false });
    const result = await callTool(computer, 'computer_info', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('container is not running') });
  });

  it('reports timeouts even when the probe returns partial output', async () => {
    const { computer } = recording();
    computer.exec = async () => ({ exitCode: 0, stdout: 'partial', stderr: '', durationMs: 20_000, timedOut: true, truncated: false });
    const result = await callTool(computer, 'computer_info', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('probe timed out') });
  });
});

describe('shell', () => {
  function stub(result: Partial<Awaited<ReturnType<Computer['exec']>>> = {}): { computer: Computer; seen: number[] } {
    const seen: number[] = [];
    const computer = {
      info: { id: 'cmp_test', provider: 'docker', image: 'debian:bookworm-slim', spec: {} },
      exec: async (req: { timeoutSec?: number }) => {
        seen.push(req.timeoutSec as number);
        return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, truncated: false, ...result };
      },
    } as unknown as Computer;
    return { computer, seen };
  }

  it('never runs without a limit, nor with one past an hour', async () => {
    const { computer, seen } = stub();
    for (const timeoutSec of [0, -1, 99_999_999, 30, undefined]) await callTool(computer, 'shell', { command: 'true', timeoutSec });
    expect(seen).toEqual([120, 120, 3600, 30, 120]);
  });

  it('says a timed-out command was stopped only when the provider confirmed it', async () => {
    const stopped = await callTool(stub({ timedOut: true, exitCode: 124, durationMs: 2000 }).computer, 'shell', { command: 'sleep 9' });
    expect(stopped.content[0]).toMatchObject({ text: expect.stringContaining('[timed out after 2s and was stopped]') });

    const unsure = await callTool(stub({ timedOut: true, exitCode: 124, durationMs: 2000, stderr: STOP_UNCONFIRMED }).computer, 'shell', { command: 'sleep 9' });
    const text = (unsure.content[0] as { text: string }).text;
    expect(text).toContain('[timed out after 2s]');
    expect(text).not.toContain('was stopped');
    expect(text).toContain(STOP_UNCONFIRMED);
  });

  it('hands the chat’s cancel to the command, and to the computer_info probe', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const computer = {
      info: { id: 'cmp_test', provider: 'docker', image: 'debian:bookworm-slim', spec: {} },
      exec: async (req: { signal?: AbortSignal }) => {
        signals.push(req.signal);
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
      },
    } as unknown as Computer;
    const cancel = new AbortController();
    await callTool(computer, 'shell', { command: 'sleep 9' }, cancel.signal);
    await callTool(computer, 'computer_info', {}, cancel.signal);
    expect(signals).toEqual([cancel.signal, cancel.signal]);
  });
});

describe('model timeouts', () => {
  it('are finite, positive and at most ten minutes, whatever the model sends', () => {
    expect(secondsArg(3_000_000, 15)).toBe(MAX_WAIT_SEC);
    expect(secondsArg(Infinity, 15)).toBe(15);
    expect(secondsArg(Number.NaN, 15)).toBe(15);
    expect(secondsArg(-5, 15)).toBe(15);
    expect(secondsArg('30', 15)).toBe(15);
    expect(secondsArg(20, 15)).toBe(20);
  });
});
