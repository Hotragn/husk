import type { ChatResponse, StreamEvent } from '@husk-ai/core';
import { describe, expect, it } from 'vitest';
import { jsonResponse, recordingFetch, streamResponse } from '../testing.js';
import { OllamaProvider, toOllamaMessages } from './ollama.js';

const NDJSON = [
  '{"model":"gemma3","message":{"role":"assistant","content":"Hel"},"done":false}\n',
  '{"model":"gemma3","message":{"role":"assistant","content":"lo"},"done":false}\n',
  '{"model":"gemma3","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop",',
  '"prompt_eval_count":9,"eval_count":4}\n',
];

const TAGS = {
  models: [
    { name: 'gemma3:latest', model: 'gemma3:latest', details: { family: 'gemma3', parameter_size: '4.3B' } },
    { name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', details: { family: 'qwen2', parameter_size: '7.6B' } },
  ],
};

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

function localFetch(chat: () => Response) {
  return recordingFetch((call) => {
    if (call.url.endsWith('/api/tags')) return jsonResponse(TAGS);
    if (call.url.endsWith('/api/show')) {
      return jsonResponse({
        model_info: { 'gemma3.context_length': 131072 },
        capabilities: ['completion', 'tools', 'vision'],
      });
    }
    return chat();
  });
}

describe('OllamaProvider.listModels', () => {
  it('reports what is actually pulled, at zero cost', async () => {
    const { fetch } = localFetch(() => jsonResponse({}));
    const models = await new OllamaProvider({ fetch }).listModels();

    expect(models.map((m) => m.id)).toEqual(['ollama/gemma3:latest', 'ollama/qwen2.5-coder:7b']);
    expect(models.every((m) => m.free === true)).toBe(true);
    expect(models.every((m) => m.pricing?.inputPerMTok === 0 && m.pricing?.outputPerMTok === 0)).toBe(true);
  });

  it('takes the real context window from /api/show rather than guessing', async () => {
    const { fetch } = localFetch(() => jsonResponse({}));
    const models = await new OllamaProvider({ fetch }).listModels();
    expect(models[0]?.contextWindow).toBe(131072);
    expect(models[0]?.supportsVision).toBe(true);
  });

  it('is unavailable, with a pull hint, when nothing is pulled', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ models: [] }));
    const availability = await new OllamaProvider({ fetch }).isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.hint).toContain('ollama pull qwen2.5:7b');
  });

  it('is unavailable, with an install hint, when nothing is listening', async () => {
    const { fetch } = recordingFetch(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    });
    const availability = await new OllamaProvider({ fetch }).isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('no Ollama server');
    expect(availability.hint).toContain('ollama.com');
  });

  it('accepts an OLLAMA_HOST with no scheme', async () => {
    const { fetch, calls } = localFetch(() => jsonResponse({}));
    await new OllamaProvider({ fetch, env: { OLLAMA_HOST: 'localhost:11434' } }).listModels();
    expect(calls[0]?.url).toBe('http://localhost:11434/api/tags');
  });
});

describe('OllamaProvider.stream', () => {
  it('parses NDJSON into text deltas and a priced-at-zero done event', async () => {
    const { fetch, calls } = localFetch(() => streamResponse(NDJSON));
    const provider = new OllamaProvider({ fetch });
    const events = await drain(
      provider.stream({ model: 'ollama/gemma3', messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'Hel',
      'lo',
    ]);
    const done = { response: doneOf(events) };
    expect(done.response.usage).toEqual({ inputTokens: 9, outputTokens: 4, costUsd: 0 });
    expect((calls[0]?.body as Record<string, unknown>)['stream']).toBe(true);
  });

  it('reassembles a chunk boundary inside a JSON object', async () => {
    const joined = NDJSON.join('');
    const third = Math.floor(joined.length / 3);
    const { fetch } = localFetch(() =>
      streamResponse([joined.slice(0, third), joined.slice(third, third * 2), joined.slice(third * 2)]),
    );
    const events = await drain(
      new OllamaProvider({ fetch }).stream({ model: 'gemma3', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(2);
  });

  it('reads a native tool call whose arguments arrive already decoded', async () => {
    const { fetch } = localFetch(() =>
      streamResponse([
        '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"shell","arguments":{"cmd":"pwd"}}}]},"done":false}\n',
        '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n',
      ]),
    );
    const events = await drain(
      new OllamaProvider({ fetch }).stream({ model: 'gemma3', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const call = events.find((e) => e.type === 'tool_call') as { call: { name: string; args: unknown } };
    expect(call.call).toMatchObject({ name: 'shell', args: { cmd: 'pwd' } });
  });

  it('accumulates a tool call whose arguments arrive as partial JSON', async () => {
    const { fetch } = localFetch(() =>
      streamResponse([
        '{"message":{"tool_calls":[{"function":{"name":"shell","arguments":"{\\"cmd\\":"}}]},"done":false}\n',
        '{"message":{"tool_calls":[{"function":{"name":"shell","arguments":"\\"pwd\\"}"}}]},"done":false}\n',
        '{"message":{"content":""},"done":true,"done_reason":"stop"}\n',
      ]),
    );
    const events = await drain(
      new OllamaProvider({ fetch }).stream({ model: 'gemma3', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect((calls[0] as { call: { args: unknown } }).call.args).toEqual({ cmd: 'pwd' });
  });

  it('sends tools in Ollama’s native shape', async () => {
    const { fetch, calls } = localFetch(() => streamResponse(NDJSON));
    await drain(
      new OllamaProvider({ fetch }).stream({
        model: 'gemma3',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'shell', description: 'run', parameters: { type: 'object' } }],
      }),
    );
    expect((calls[0]?.body as Record<string, unknown>)['tools']).toEqual([
      { type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } },
    ]);
  });
});

describe('message translation', () => {
  it('splits tool results into their own tool-role messages', () => {
    const wire = toOllamaMessages(
      [
        { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'shell', args: { cmd: 'ls' } }] },
        { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'a.txt' }] },
      ],
      'be terse',
    ) as Array<Record<string, unknown>>;
    expect(wire.map((m) => m['role'])).toEqual(['system', 'assistant', 'tool']);
    expect(wire[1]?.['tool_calls']).toEqual([{ function: { name: 'shell', arguments: { cmd: 'ls' } } }]);
  });

  it('sends images as bare base64, not data URLs', () => {
    const wire = toOllamaMessages([
      { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }] },
    ]) as Array<Record<string, unknown>>;
    expect(wire[0]?.['images']).toEqual(['QUJD']);
  });
});
