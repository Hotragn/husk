import type { ChatResponse, StreamEvent } from '@husk-ai/core';
import { HuskError } from '@husk-ai/core';
import { describe, expect, it } from 'vitest';
import { errorResponse, jsonResponse, recordingFetch, streamResponse } from '../testing.js';
import { AnthropicProvider, toAnthropicMessages, withPromptCaching } from './anthropic.js';

const KEY = 'sk-ant-api03-THISISNOTAREALKEYITISJUSTLONG';

/** A complete Anthropic SSE response, deliberately split at awkward byte offsets. */
const SSE_WITH_TOOL_CALL = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":37,',
  '"output_tokens":1,"cache_read_input_tokens":1024,"cache_creation_input_tokens":256}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Chec"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"king."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"shell","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\"'
    + ': \\"ls '
    + '"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"-la\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":48}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

async function drain(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

function doneOf(events: StreamEvent[]): ChatResponse {
  const done = events.find((e) => e.type === 'done');
  if (done?.type !== 'done') throw new Error('stream ended without a done event');
  return done.response;
}

describe('AnthropicProvider.stream', () => {
  it('parses the SSE shape into husk events', async () => {
    const { fetch, calls } = recordingFetch(() => streamResponse(SSE_WITH_TOOL_CALL));
    const provider = new AnthropicProvider({ apiKey: KEY, fetch });

    const events = await drain(
      provider.stream({ model: 'anthropic/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(events[0]).toEqual({ type: 'start', model: 'anthropic/claude-sonnet-5' });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'Chec',
      'king.',
    ]);
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]?.headers['x-api-key']).toBe(KEY);
  });

  it('emits a tool call only once its partial JSON parses', async () => {
    const { fetch } = recordingFetch(() => streamResponse(SSE_WITH_TOOL_CALL));
    const provider = new AnthropicProvider({ apiKey: KEY, fetch });
    const events = await drain(
      provider.stream({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
    );

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      type: 'tool_call',
      call: { type: 'tool_call', id: 'toolu_01', name: 'shell', args: { cmd: 'ls -la' } },
    });
  });

  it('reports cache reads and writes separately, and prices them', async () => {
    const { fetch } = recordingFetch(() => streamResponse(SSE_WITH_TOOL_CALL));
    const provider = new AnthropicProvider({ apiKey: KEY, fetch });
    const events = await drain(
      provider.stream({ model: 'anthropic/claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] }),
    );

    const usage = doneOf(events).usage;
    expect(usage).toMatchObject({
      inputTokens: 37,
      outputTokens: 48,
      cacheReadTokens: 1024,
      cacheWriteTokens: 256,
    });
    // 37 in @ $1, 48 out @ $5, 1024 cache reads @ $0.1, 256 writes @ $1.25 per MTok.
    expect(usage.costUsd).toBeCloseTo(
      (37 * 1 + 48 * 5 + 1024 * 0.1 + 256 * 1.25) / 1_000_000,
      10,
    );
  });

  it('surfaces a mid-stream error event as a retryable HuskError', async () => {
    const { fetch } = recordingFetch(() =>
      streamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    );
    const provider = new AnthropicProvider({ apiKey: KEY, fetch });
    await expect(
      drain(provider.stream({ model: 'anthropic/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toThrowError(/overloaded_error/);
  });
});

describe('AnthropicProvider.chat', () => {
  it('sends extended thinking and widens max_tokens to fit the budget', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const provider = new AnthropicProvider({ apiKey: KEY, fetch });
    await provider.chat({
      model: 'anthropic/claude-opus-5',
      messages: [{ role: 'user', content: 'think' }],
      maxTokens: 1_000,
      temperature: 0.7,
      thinking: { enabled: true, budgetTokens: 8_000 },
    });

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 8_000 });
    expect(body['max_tokens']).toBe(9_024);
    // Sampling overrides are rejected while thinking is on.
    expect(body).not.toHaveProperty('temperature');
  });

  it('never lets the API key reach the error message', async () => {
    const { fetch } = recordingFetch(() =>
      errorResponse(401, { error: { message: `invalid key ${KEY} supplied` } }),
    );
    const provider = new AnthropicProvider({ apiKey: KEY, fetch });
    try {
      await provider.chat({ model: 'anthropic/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HuskError);
      expect((err as HuskError).code).toBe('E_NO_CREDENTIALS');
      expect((err as HuskError).message).not.toContain(KEY);
      expect((err as HuskError).message).toContain('[redacted api key]');
    }
  });

  it('refuses without a key, and says how to get running for free', async () => {
    const provider = new AnthropicProvider({ apiKey: undefined, env: {} });
    const availability = await provider.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.hint).toContain('ollama pull qwen2.5:7b');
  });
});

describe('message translation', () => {
  it('moves tool results into a user turn, the way Anthropic models them', () => {
    const wire = toAnthropicMessages([
      { role: 'user', content: 'run ls' },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'shell', args: { cmd: 'ls' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'a.txt' }] },
    ]);
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(wire[2]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'c1', content: 'a.txt' });
  });

  it('coalesces adjacent same-role turns, which the API rejects', () => {
    const wire = toAnthropicMessages([
      { role: 'user', content: '[husk elided 4 earlier messages]' },
      { role: 'user', content: 'and now this' },
    ]);
    expect(wire).toHaveLength(1);
    expect(wire[0]?.content).toHaveLength(2);
  });

  it('drops a thinking block that has lost its signature', () => {
    const wire = toAnthropicMessages([
      { role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'hi' }] },
    ]);
    expect(wire[0]?.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('caches the last stable user turn, not the newest one', () => {
    const wire = withPromptCaching(
      toAnthropicMessages([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'newest' },
      ]),
    );
    expect(wire[2]?.content[0]).toHaveProperty('cache_control', { type: 'ephemeral' });
    expect(wire[4]?.content[0]).not.toHaveProperty('cache_control');
  });

  it('does not mark a cache breakpoint on a single-turn conversation', () => {
    const wire = withPromptCaching(toAnthropicMessages([{ role: 'user', content: 'hi' }]));
    expect(wire[0]?.content[0]).not.toHaveProperty('cache_control');
  });

  it('marks the system prompt for caching', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const provider = new AnthropicProvider({ apiKey: KEY, fetch });
    await provider.chat({
      model: 'anthropic/claude-sonnet-5',
      system: 'You are Husk.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect((calls[0]?.body as Record<string, unknown>)['system']).toEqual([
      { type: 'text', text: 'You are Husk.', cache_control: { type: 'ephemeral' } },
    ]);
  });
});
