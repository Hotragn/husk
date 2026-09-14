import type { ModelMessage } from '@husk-ai/core';
import { describe, expect, it } from 'vitest';
import {
  danglingToolCalls,
  estimateMessages,
  estimateTools,
  fitContext,
  orphanedToolResults,
} from './tokens.js';

/** One agent turn: ask, call a tool, get a chunky result back, answer. */
function toolRound(n: number, resultSize = 2_000): ModelMessage[] {
  return [
    { role: 'user', content: `question ${n} ${'q'.repeat(80)}` },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `let me look, round ${n}` },
        { type: 'tool_call', id: `call_${n}`, name: 'shell', args: { cmd: `ls -la /round/${n}` } },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool_result', toolCallId: `call_${n}`, content: 'x'.repeat(resultSize) }],
    },
    { role: 'assistant', content: `answer ${n}` },
  ];
}

function conversation(rounds: number): ModelMessage[] {
  const out: ModelMessage[] = [{ role: 'system', content: 'You are Husk.' }];
  for (let i = 0; i < rounds; i++) out.push(...toolRound(i));
  return out;
}

describe('estimateMessages', () => {
  it('grows with the prompt', () => {
    const small = estimateMessages([{ role: 'user', content: 'hi' }]);
    const large = estimateMessages([{ role: 'user', content: 'hi '.repeat(1_000) }]);
    expect(large).toBeGreaterThan(small * 100);
  });

  it('counts tool schemas, which are part of every request', () => {
    const tools = [
      { name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
    ];
    expect(estimateTools(tools)).toBeGreaterThan(16);
    expect(estimateMessages([], tools)).toBeGreaterThan(estimateMessages([]));
  });

  it('counts an image as more than its base64 length would suggest for text', () => {
    const withImage = estimateMessages([
      { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
    ]);
    expect(withImage).toBeGreaterThan(1_000);
  });
});

describe('fitContext', () => {
  it('returns the conversation untouched when it already fits', () => {
    const messages = conversation(2);
    const fit = fitContext(messages, 1_000_000);
    expect(fit.messages).toEqual(messages);
    expect(fit.dropped).toEqual([]);
  });

  it('never orphans a tool_result, at any budget', () => {
    const messages = conversation(12);
    for (const budget of [300, 600, 1_200, 2_500, 5_000, 10_000]) {
      const fit = fitContext(messages, budget);
      expect(orphanedToolResults(fit.messages), `budget ${budget}`).toEqual([]);
      expect(danglingToolCalls(fit.messages), `budget ${budget}`).toEqual([]);
    }
  });

  it('drops a tool call and its result as one unit', () => {
    const fit = fitContext(conversation(10), 2_000);
    const droppedCalls = fit.dropped.flatMap((m) =>
      typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'tool_call').map((p) => p.id),
    );
    const droppedResults = fit.dropped.flatMap((m) =>
      typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'tool_result').map((p) => p.toolCallId),
    );
    expect(droppedCalls.sort()).toEqual(droppedResults.sort());
    expect(droppedCalls.length).toBeGreaterThan(0);
  });

  it('always keeps the system prompt', () => {
    const fit = fitContext(conversation(12), 400);
    expect(fit.messages[0]).toEqual({ role: 'system', content: 'You are Husk.' });
  });

  it('always keeps the first user turn', () => {
    const fit = fitContext(conversation(12), 500);
    const text = JSON.stringify(fit.messages);
    expect(text).toContain('question 0');
  });

  it('always keeps the most recent turns', () => {
    const fit = fitContext(conversation(12), 1_500, { keepLastTurns: 4 });
    expect(JSON.stringify(fit.messages)).toContain('answer 11');
  });

  it('leaves a note where the elision happened', () => {
    const fit = fitContext(conversation(12), 1_500);
    expect(JSON.stringify(fit.messages)).toMatch(/husk elided \d+ earlier messages/);
  });

  it('can be told not to leave a note', () => {
    const fit = fitContext(conversation(12), 1_500, { summarise: false });
    expect(JSON.stringify(fit.messages)).not.toContain('husk elided');
  });

  it('reserves room for the reply', () => {
    const messages = conversation(10);
    const generous = fitContext(messages, 6_000, { reserveOutputTokens: 0 });
    const reserved = fitContext(messages, 6_000, { reserveOutputTokens: 4_000 });
    expect(reserved.dropped.length).toBeGreaterThan(generous.dropped.length);
  });

  it('clamps oversized tool output when dropping is not enough', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'shell', args: { cmd: 'cat big' } }],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'y'.repeat(200_000) }] },
    ];
    const fit = fitContext(messages, 2_000);
    expect(fit.truncated).toBe(true);
    expect(orphanedToolResults(fit.messages)).toEqual([]);
    expect(JSON.stringify(fit.messages)).toContain('elided by husk');
    expect(fit.tokens).toBeLessThan(estimateMessages(messages));
  });

  it('counts the tools and system prompt against the budget', () => {
    const tools = [
      { name: 'shell', description: 'x'.repeat(4_000), parameters: { type: 'object' } },
    ];
    const bare = fitContext(conversation(8), 4_000);
    const withTools = fitContext(conversation(8), 4_000, { tools, system: 'y'.repeat(4_000) });
    expect(withTools.dropped.length).toBeGreaterThan(bare.dropped.length);
  });
});

describe('orphanedToolResults', () => {
  it('finds a result whose call was removed', () => {
    const broken: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'gone', content: 'ok' }] },
    ];
    expect(orphanedToolResults(broken)).toEqual(['gone']);
  });

  it('finds a call whose result was removed', () => {
    const broken: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', args: {} }] },
    ];
    expect(danglingToolCalls(broken)).toEqual(['c1']);
  });
});
