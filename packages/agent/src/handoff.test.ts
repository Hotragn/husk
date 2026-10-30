import { createLogger } from '@husk-ai/core';
import type { HandoffRequest, ModelMessage, ToolResultPart } from '@husk-ai/core';
import { describe, expect, it } from 'vitest';
import { Agent } from './loop.js';
import { FakeRouter, abortableDelay, specFor, toolCall, type ScriptedTurn } from './test-support.js';
import { hand_off } from './tools/handoff.js';
import type { AgentRunOptions } from './types.js';

const silent = createLogger({ level: 'silent' });

function handoffTurns(reason = 'Sign in to example.com'): ScriptedTurn[] {
  return [
    { toolCalls: [toolCall('h1', 'hand_off', { reason })] },
    { text: 'carrying on' },
  ];
}

function agentFor(turns: ScriptedTurn[], timeoutSec?: number) {
  return new Agent({
    spec: specFor({ persona: 'be useful', ...(timeoutSec === undefined ? {} : { limits: { timeoutSec } }) }),
    router: new FakeRouter(turns),
    tools: [hand_off] as never,
    logger: silent,
  });
}

function resultOf(messages: ModelMessage[]): ToolResultPart {
  const part = messages
    .filter((m) => m.role === 'tool')
    .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
    .find((p): p is ToolResultPart => p.type === 'tool_result');
  if (!part) throw new Error('no tool result');
  return part;
}

function text(part: ToolResultPart): string {
  return typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
}

describe('hand_off', () => {
  it('refuses at once when nobody is wired to take over, instead of hanging', async () => {
    const result = await agentFor(handoffTurns()).run({ input: 'go' } as AgentRunOptions);
    expect(result.stopReason).toBe('complete');
    expect(text(resultOf(result.messages))).toMatch(/nobody is connected/);
  });

  it('resumes the run only on done, and tells the model to look again', async () => {
    const seen: HandoffRequest[] = [];
    const result = await agentFor(handoffTurns()).run({
      input: 'go',
      onHandoff: async (req) => {
        seen.push(req);
        return 'done';
      },
    } as AgentRunOptions);
    expect(result.stopReason).toBe('complete');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe('Sign in to example.com');
    expect(text(resultOf(result.messages))).toMatch(/look again/);
  });

  it('reports an aborted wait as an error, not as success', async () => {
    const result = await agentFor(handoffTurns()).run({
      input: 'go',
      onHandoff: async () => 'aborted',
    } as AgentRunOptions);
    expect(text(resultOf(result.messages))).toMatch(/ended before the person finished/);
  });

  it('treats a throwing handler as an aborted wait', async () => {
    const result = await agentFor(handoffTurns()).run({
      input: 'go',
      onHandoff: async () => {
        throw new Error('viewer fell over');
      },
    } as AgentRunOptions);
    expect(text(resultOf(result.messages))).toMatch(/ended before the person finished/);
  });

  it('redacts a secret the model put in the reason before the person sees it', async () => {
    const token = `sk-ant-${'Q'.repeat(40)}`;
    const seen: HandoffRequest[] = [];
    await agentFor(handoffTurns(`Use ${token} to sign in`)).run({
      input: 'go',
      onHandoff: async (req) => {
        seen.push(req);
        return 'done';
      },
    } as AgentRunOptions);
    expect(seen[0]?.reason).not.toContain('Q'.repeat(40));
    expect(seen[0]?.reason).toContain('[redacted]');
  });

  it('rejects an empty or over-long reason before anyone is bothered', async () => {
    let called = false;
    const onHandoff = async () => {
      called = true;
      return 'done' as const;
    };
    const blank = await agentFor(handoffTurns('   ')).run({ input: 'go', onHandoff } as AgentRunOptions);
    expect(text(resultOf(blank.messages))).toMatch(/needs a reason/);
    const long = await agentFor(handoffTurns('x'.repeat(501))).run({ input: 'go', onHandoff } as AgentRunOptions);
    expect(text(resultOf(long.messages))).toMatch(/over 500 characters/);
    expect(called).toBe(false);
  });

  it('does not let the time limit run out while a person holds the handoff', async () => {
    // Without a handoff a 0.2s limit ends the run as a timeout. With one, the
    // wait is longer than the limit and the run must still finish normally.
    const slow = await agentFor(handoffTurns(), 0.2).run({
      input: 'go',
      onHandoff: async (_req, signal) => {
        await abortableDelay(600, signal);
        return 'done';
      },
    } as AgentRunOptions);
    expect(slow.stopReason).toBe('complete');

    const control = await agentFor([{ delayMs: 600, text: 'late' }], 0.2).run({ input: 'go' } as AgentRunOptions);
    expect(control.stopReason).toBe('timeout');
  });

  it('ends the wait when the run is cancelled, and hands the signal to the handler', async () => {
    const controller = new AbortController();
    let handlerSignal: AbortSignal | undefined;
    const run = agentFor(handoffTurns()).run({
      input: 'go',
      signal: controller.signal,
      onHandoff: async (_req, signal) => {
        handlerSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return 'aborted';
      },
    } as AgentRunOptions);
    setTimeout(() => controller.abort(), 150);
    const result = await run;
    expect(handlerSignal?.aborted).toBe(true);
    expect(result.stopReason).toBe('aborted');
  });
});
