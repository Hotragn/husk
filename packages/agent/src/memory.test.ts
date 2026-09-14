import { describe, expect, it } from 'vitest';
import type { ContentPart, ModelMessage } from '@husk-ai/core';
import { pruneOrphans, renderForSummary, trimHistory } from './memory.js';

function user(text: string): ModelMessage {
  return { role: 'user', content: text };
}
function assistantCalling(text: string, id: string, name = 'shell'): ModelMessage {
  const parts: ContentPart[] = [
    { type: 'text', text },
    { type: 'tool_call', id, name, args: { command: 'ls' } },
  ];
  return { role: 'assistant', content: parts };
}
function toolResult(id: string, content = 'ok'): ModelMessage {
  return { role: 'tool', content: [{ type: 'tool_result', toolCallId: id, content }] };
}

/** Every tool_call must have a later tool_result, and vice versa. */
function assertPaired(messages: ModelMessage[]): void {
  const calls: string[] = [];
  const results: string[] = [];
  messages.forEach((m, i) => {
    if (typeof m.content === 'string') return;
    for (const p of m.content) {
      if (p.type === 'tool_call') calls.push(`${p.id}@${i}`);
      if (p.type === 'tool_result') results.push(`${p.toolCallId}@${i}`);
    }
  });
  const callIds = calls.map((c) => c.split('@')[0]);
  const resultIds = results.map((r) => r.split('@')[0]);
  expect(new Set(callIds)).toEqual(new Set(resultIds));
  for (const id of callIds) {
    const callAt = Number(calls.find((c) => c.startsWith(`${id}@`))!.split('@')[1]);
    const resultAt = Number(results.find((r) => r.startsWith(`${id}@`))!.split('@')[1]);
    expect(resultAt).toBeGreaterThan(callAt);
  }
}

function conversation(turns: number): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(user(`question ${i}`));
    out.push(assistantCalling(`working on ${i}`, `call_${i}`));
    out.push(toolResult(`call_${i}`, `result ${i}`));
    out.push({ role: 'assistant', content: `answer ${i}` });
  }
  return out;
}

describe('trimHistory', () => {
  it('leaves a short conversation untouched', async () => {
    const messages = conversation(3);
    const out = await trimHistory(messages, { windowTurns: 20 });
    expect(out.elided).toBe(0);
    expect(out.messages).toBe(messages);
  });

  it('keeps the system prompt, the first user turn and the last window', async () => {
    const messages: ModelMessage[] = [{ role: 'system', content: 'be terse' }, ...conversation(10)];
    const out = await trimHistory(messages, { windowTurns: 2 });

    expect(out.elided).toBeGreaterThan(0);
    expect(out.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(out.messages[1]).toEqual(user('question 0'));
    expect(String(out.messages[2]?.content)).toContain('elided');
    expect(out.messages.at(-1)).toEqual({ role: 'assistant', content: 'answer 9' });
    expect(out.messages).toContainEqual(user('question 8'));
    expect(out.messages).not.toContainEqual(user('question 5'));
  });

  it('never orphans a tool_result', async () => {
    for (const windowTurns of [1, 2, 3, 5]) {
      const out = await trimHistory(conversation(12), { windowTurns });
      assertPaired(out.messages);
    }
  });

  it('never orphans a tool_result when the cut lands mid-turn', async () => {
    // A turn with several tool calls is exactly where a naive slice goes wrong.
    const messages: ModelMessage[] = [
      user('start'),
      assistantCalling('one', 'a'),
      toolResult('a'),
      assistantCalling('two', 'b'),
      toolResult('b'),
      user('next'),
      assistantCalling('three', 'c'),
      toolResult('c'),
      user('last'),
      { role: 'assistant', content: 'fine' },
    ];
    const out = await trimHistory(messages, { windowTurns: 1 });
    assertPaired(out.messages);
    expect(out.messages.some((m) => JSON.stringify(m.content).includes('"a"'))).toBe(false);
  });

  it('summarises the middle when a summariser is supplied', async () => {
    const out = await trimHistory(conversation(10), {
      windowTurns: 2,
      summarise: true,
      summariser: async (slice) => `covered ${slice.length} messages`,
    });
    expect(out.summarised).toBe(true);
    expect(out.messages.some((m) => String(m.content).includes('covered'))).toBe(true);
  });

  it('degrades to a marker when the summariser fails', async () => {
    const warnings: string[] = [];
    const out = await trimHistory(conversation(10), {
      windowTurns: 2,
      summarise: true,
      summariser: async () => {
        throw new Error('no cheap model available');
      },
      onWarning: (m) => warnings.push(m),
    });
    expect(out.summarised).toBe(false);
    expect(out.messages.some((m) => String(m.content).includes('elided'))).toBe(true);
    expect(warnings[0]).toContain('no cheap model available');
  });
});

describe('pruneOrphans', () => {
  it('drops a tool_result with no matching call', () => {
    const out = pruneOrphans([user('hi'), toolResult('ghost')]);
    expect(out).toEqual([user('hi')]);
  });

  it('drops a tool_call whose result was lost, keeping the text', () => {
    const out = pruneOrphans([user('hi'), assistantCalling('thinking out loud', 'x')]);
    expect(out).toHaveLength(2);
    expect(out[1]?.content).toEqual([{ type: 'text', text: 'thinking out loud' }]);
  });

  it('keeps a properly paired exchange intact', () => {
    const input = [user('hi'), assistantCalling('working', 'x'), toolResult('x')];
    expect(pruneOrphans(input)).toHaveLength(3);
  });
});

describe('renderForSummary', () => {
  it('includes tool calls so the summary knows what was attempted', () => {
    const text = renderForSummary([user('build it'), assistantCalling('sure', 'x'), toolResult('x', 'exit 0')]);
    expect(text).toContain('user: build it');
    expect(text).toContain('called: shell(');
    expect(text).toContain('exit 0');
  });

  it('truncates rather than handing a cheap model a novel', () => {
    const long = renderForSummary([user('x'.repeat(50_000))], 500);
    expect(long.length).toBeLessThanOrEqual(504);
  });
});
