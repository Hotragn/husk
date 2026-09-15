import type { ChatResponse, StreamEvent } from '@husk-ai/core';
import { HuskError } from '@husk-ai/core';
import { describe, expect, it } from 'vitest';
import { errorResponse, jsonResponse, recordingFetch, streamResponse } from '../testing.js';
import {
  COMPATIBLE_CONFIGS,
  GroqProvider,
  OpenRouterProvider,
  type CompatibleProviderId,
} from './compatible.js';
import { OpenAIProvider } from './openai.js';
import { OpenAICompatibleProvider, toOpenAIMessages } from './openai-compatible.js';

const KEY = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * OpenAI splits tool-call arguments at bytes of its own choosing and never repeats
 * the function name after the first fragment.
 */
const SSE_WITH_TOOL_CALL = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"One "}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"moment."}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"shell","arguments":""}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"uname -a\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":20}}}\n\n',
  'data: [DONE]\n\n',
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

describe('OpenAI-compatible streaming', () => {
  it('yields text deltas as the frames arrive', async () => {
    const { fetch } = recordingFetch(() => streamResponse(SSE_WITH_TOOL_CALL));
    const provider = new OpenAIProvider({ apiKey: KEY, fetch });
    const events = await drain(
      provider.stream({ model: 'openai/gpt-4.1', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'One ',
      'moment.',
    ]);
  });

  it('accumulates tool arguments across chunk boundaries and emits one call', async () => {
    const { fetch } = recordingFetch(() => streamResponse(SSE_WITH_TOOL_CALL));
    const provider = new OpenAIProvider({ apiKey: KEY, fetch });
    const events = await drain(
      provider.stream({ model: 'openai/gpt-4.1', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: 'tool_call',
      call: { type: 'tool_call', id: 'call_abc', name: 'shell', args: { cmd: 'uname -a' } },
    });
  });

  it('subtracts cached tokens from the billable input', async () => {
    const { fetch } = recordingFetch(() => streamResponse(SSE_WITH_TOOL_CALL));
    const provider = new OpenAIProvider({ apiKey: KEY, fetch });
    const events = await drain(
      provider.stream({ model: 'openai/gpt-4.1', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const done = { response: doneOf(events) };
    expect(done.response.usage).toMatchObject({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 20 });
    expect(done.response.finishReason).toBe('tool_calls');
    expect(done.response.usage.costUsd).toBeCloseTo((100 * 2 + 30 * 8 + 20 * 0.5) / 1_000_000, 10);
  });

  it('parses the same stream when every frame is split in half', async () => {
    const halved = SSE_WITH_TOOL_CALL.flatMap((chunk) => [
      chunk.slice(0, Math.floor(chunk.length / 2)),
      chunk.slice(Math.floor(chunk.length / 2)),
    ]);
    const { fetch } = recordingFetch(() => streamResponse(halved));
    const provider = new OpenAIProvider({ apiKey: KEY, fetch });
    const events = await drain(
      provider.stream({ model: 'openai/gpt-4.1', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });
});

describe('OpenAI request shaping', () => {
  it('renames max_tokens and drops sampling for the reasoning models', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    );
    const provider = new OpenAIProvider({ apiKey: KEY, fetch });
    await provider.chat({
      model: 'openai/o3',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 500,
      temperature: 0.2,
      thinking: { enabled: true, budgetTokens: 32_000 },
    });
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['max_completion_tokens']).toBe(500);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body['reasoning_effort']).toBe('high');
  });

  it('leaves the non-reasoning models alone', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    );
    const provider = new OpenAIProvider({ apiKey: KEY, fetch });
    await provider.chat({
      model: 'openai/gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 500,
      temperature: 0.2,
    });
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['max_tokens']).toBe(500);
    expect(body['temperature']).toBe(0.2);
  });

  it('normalises a 429 into a retryable quota error', async () => {
    const { fetch } = recordingFetch(() => errorResponse(429, { error: { message: 'slow down' } }));
    const provider = new OpenAIProvider({ apiKey: KEY, fetch });
    try {
      await provider.chat({ model: 'openai/gpt-4.1', messages: [{ role: 'user', content: 'hi' }] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as HuskError).code).toBe('E_QUOTA');
      expect((err as HuskError).details).toMatchObject({ retryable: true, status: 429 });
    }
  });

  it('marks a 400 as not worth retrying', async () => {
    const { fetch } = recordingFetch(() => errorResponse(400, { error: { message: 'bad schema' } }));
    const provider = new OpenAIProvider({ apiKey: KEY, fetch });
    try {
      await provider.chat({ model: 'openai/gpt-4.1', messages: [{ role: 'user', content: 'hi' }] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as HuskError).details).toMatchObject({ retryable: false, status: 400 });
    }
  });
});

describe('the thin configurations', () => {
  it('point Groq at its own base URL with its own key', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    );
    const provider = new GroqProvider({ apiKey: 'gsk_test', fetch });
    expect(provider.id).toBe('groq');
    await provider.chat({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(calls[0]?.headers['authorization']).toBe('Bearer gsk_test');
  });

  it('report themselves unavailable with an actionable hint when unkeyed', async () => {
    const provider = new GroqProvider({ env: {} });
    const availability = await provider.isAvailable();
    expect(availability).toMatchObject({ available: false });
    expect(availability.hint).toContain('GROQ_API_KEY');
  });

  /**
   * The whole point of the config table is that a wrong base URL or a typo'd
   * environment variable is a silent 404 or a silent "unavailable" months later.
   * Pin every value that a user's key has to travel through.
   */
  const EXPECTED: Array<{
    id: CompatibleProviderId;
    url: string;
    envKey: string | undefined;
    hostEnvKey?: string;
  }> = [
    { id: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', envKey: 'GROQ_API_KEY' },
    { id: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', envKey: 'OPENROUTER_API_KEY' },
    { id: 'together', url: 'https://api.together.xyz/v1/chat/completions', envKey: 'TOGETHER_API_KEY' },
    { id: 'deepseek', url: 'https://api.deepseek.com/v1/chat/completions', envKey: 'DEEPSEEK_API_KEY' },
    { id: 'mistral', url: 'https://api.mistral.ai/v1/chat/completions', envKey: 'MISTRAL_API_KEY' },
    { id: 'cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', envKey: 'CEREBRAS_API_KEY' },
    {
      id: 'lmstudio',
      url: 'http://127.0.0.1:1234/v1/chat/completions',
      envKey: undefined,
      hostEnvKey: 'LMSTUDIO_HOST',
    },
  ];

  it.each(EXPECTED)('$id posts to its own base URL', async ({ id, url, envKey }) => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    );
    const env = envKey ? { [envKey]: 'k-test' } : {};
    const provider = new OpenAICompatibleProvider(COMPATIBLE_CONFIGS[id], { env, fetch });
    await provider.chat({ model: 'some-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]?.url).toBe(url);
  });

  it.each(EXPECTED.filter((p) => p.envKey !== undefined))(
    '$id reads its credential from $envKey and names it in the hint',
    async ({ id, envKey }) => {
      const key = envKey!;
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
      );
      const keyed = new OpenAICompatibleProvider(COMPATIBLE_CONFIGS[id], { env: { [key]: 'k-from-env' }, fetch });
      expect(await keyed.isAvailable()).toEqual({ available: true });
      await keyed.chat({ model: 'some-model', messages: [{ role: 'user', content: 'hi' }] });
      expect(calls[0]?.headers['authorization']).toBe('Bearer k-from-env');

      const unkeyed = new OpenAICompatibleProvider(COMPATIBLE_CONFIGS[id], { env: {} });
      const availability = await unkeyed.isAvailable();
      expect(availability.available).toBe(false);
      expect(availability.reason).toContain(key);
      expect(availability.hint).toContain(key);
    },
  );

  it('lets LMSTUDIO_HOST move the local server without touching the code', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    );
    const provider = new OpenAICompatibleProvider(COMPATIBLE_CONFIGS.lmstudio, {
      env: { LMSTUDIO_HOST: 'http://192.168.1.9:9999/v1/' },
      fetch,
    });
    await provider.chat({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]?.url).toBe('http://192.168.1.9:9999/v1/chat/completions');
  });

  it('reports LM Studio as unavailable, not broken, when nothing is listening', async () => {
    const { fetch } = recordingFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const availability = await new OpenAICompatibleProvider(COMPATIBLE_CONFIGS.lmstudio, { env: {}, fetch }).isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.hint).toContain('LM Studio');
  });

  it('sends OpenRouter its attribution headers, which nothing else gets', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    );
    await new OpenRouterProvider({ apiKey: 'sk-or-test', fetch }).chat({
      model: 'deepseek/deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0]?.headers['http-referer']).toBe('https://github.com/Hotragn/husk');
    expect(calls[0]?.headers['x-title']).toBe('Husk');

    const { fetch: groqFetch, calls: groqCalls } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    );
    await new GroqProvider({ apiKey: 'gsk_test', fetch: groqFetch }).chat({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(groqCalls[0]?.headers['http-referer']).toBeUndefined();
  });

  it('omits stream_options for the gateways that reject unknown fields', async () => {
    for (const id of ['mistral', 'cerebras', 'lmstudio'] as const) {
      const { fetch, calls } = recordingFetch(() => streamResponse(['data: [DONE]\n\n']));
      const provider = new OpenAICompatibleProvider(COMPATIBLE_CONFIGS[id], { apiKey: 'k', fetch });
      await drain(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
      expect((calls[0]?.body as Record<string, unknown>)['stream']).toBe(true);
      expect((calls[0]?.body as Record<string, unknown>)['stream_options']).toBeUndefined();
    }

    const { fetch, calls } = recordingFetch(() => streamResponse(['data: [DONE]\n\n']));
    await drain(
      new GroqProvider({ apiKey: 'gsk_test', fetch }).stream({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect((calls[0]?.body as Record<string, unknown>)['stream_options']).toEqual({ include_usage: true });
  });
});

/**
 * OpenRouter is the only gateway where free and paid live in the same catalog under
 * near-identical ids. The `:free` suffix is the entire signal, and getting it wrong
 * means `--model free` quietly picks something that bills.
 */
describe('OpenRouter free-tier detection', () => {
  const listing = {
    data: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free' },
      { id: 'qwen/qwen-2.5-72b-instruct:free' },
      { id: 'anthropic/claude-sonnet-4' },
    ],
  };

  it('marks a discovered :free model as costing nothing', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(listing));
    const models = await new OpenRouterProvider({ apiKey: 'sk-or-test', fetch }).listModels();
    const free = models.find((m) => m.id === 'openrouter/qwen/qwen-2.5-72b-instruct:free');
    expect(free).toMatchObject({ free: true, pricing: { inputPerMTok: 0, outputPerMTok: 0 } });
  });

  it('leaves a paid model alone', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(listing));
    const models = await new OpenRouterProvider({ apiKey: 'sk-or-test', fetch }).listModels();
    expect(models.find((m) => m.id === 'openrouter/anthropic/claude-sonnet-4')?.free).toBeUndefined();
  });

  it('does not invent a free tier for a gateway that has none', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ data: [{ id: 'zephyr:free' }] }));
    const models = await new OpenAICompatibleProvider(COMPATIBLE_CONFIGS.together, {
      apiKey: 'tk',
      fetch,
    }).listModels();
    expect(models.find((m) => m.id === 'together/zephyr:free')?.free).toBeUndefined();
  });

  it('splits a nested OpenRouter id at the first slash only', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    );
    const response = await new OpenRouterProvider({ apiKey: 'sk-or-test', fetch }).chat({
      model: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect((calls[0]?.body as Record<string, unknown>)['model']).toBe('meta-llama/llama-3.3-70b-instruct:free');
    expect(response.model).toBe('openrouter/meta-llama/llama-3.3-70b-instruct:free');
    expect(response.usage.costUsd).toBe(0);
  });
});

describe('message translation', () => {
  it('lifts tool results out into their own tool messages', () => {
    const wire = toOpenAIMessages(
      [
        { role: 'user', content: 'run it' },
        { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'shell', args: { cmd: 'ls' } }] },
        { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'a.txt' }] },
      ],
      'be terse',
    ) as Array<Record<string, unknown>>;

    expect(wire.map((m) => m['role'])).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(wire[2]?.['tool_calls']).toEqual([
      { id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
    ]);
    expect(wire[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'a.txt' });
  });

  it('marks a failed tool result so the model can see it failed', () => {
    const wire = toOpenAIMessages([
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'no such file', isError: true }] },
    ]) as Array<Record<string, unknown>>;
    expect(wire[0]?.['content']).toBe('ERROR: no such file');
  });

  it('inlines images as data URLs', () => {
    const wire = toOpenAIMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', mimeType: 'image/png', data: 'QUJD' },
        ],
      },
    ]) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(wire[0]?.content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
  });
});
