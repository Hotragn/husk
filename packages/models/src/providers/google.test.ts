import type { ChatResponse, StreamEvent } from '@husk/core';
import { HuskError } from '@husk/core';
import { describe, expect, it } from 'vitest';
import { errorResponse, jsonResponse, recordingFetch, streamResponse } from '../testing.js';
import { GoogleProvider, geminiSchema, toGeminiContents } from './google.js';

const KEY = 'AIzaSyTHISISNOTAREALGOOGLEKEY0123456789';

const SSE = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Look"}]}}]}\n\n',
  'data: {"candidates":[{"content":{"parts":[{"text":"ing."}]}}]}\n\n',
  'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"shell","args":{"cmd":"pwd"}}}]}}]}\n\n',
  'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":90,"candidatesTokenCount":12,"cachedContentTokenCount":10,"thoughtsTokenCount":8}}\n\n',
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

describe('GoogleProvider.stream', () => {
  it('calls streamGenerateContent with the key in the header, not the query string', async () => {
    const { fetch, calls } = recordingFetch(() => streamResponse(SSE));
    await drain(
      new GoogleProvider({ apiKey: KEY, fetch }).stream({
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(calls[0]?.url).toContain('models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[0]?.headers['x-goog-api-key']).toBe(KEY);
  });

  it('reads text parts as deltas and function calls as tool calls', async () => {
    const { fetch } = recordingFetch(() => streamResponse(SSE));
    const events = await drain(
      new GoogleProvider({ apiKey: KEY, fetch }).stream({
        model: 'google/gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'Look',
      'ing.',
    ]);
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ call: { name: 'shell', args: { cmd: 'pwd' } } });
  });

  it('bills thinking tokens as output and cached tokens as a cache read', async () => {
    const { fetch } = recordingFetch(() => streamResponse(SSE));
    const events = await drain(
      new GoogleProvider({ apiKey: KEY, fetch }).stream({
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(doneOf(events).usage).toMatchObject({ inputTokens: 80, outputTokens: 20, cacheReadTokens: 10 });
  });

  it('parses the same stream when the frames are split at arbitrary byte boundaries', async () => {
    const halved = SSE.flatMap((chunk) => [
      chunk.slice(0, Math.floor(chunk.length / 3)),
      chunk.slice(Math.floor(chunk.length / 3)),
    ]);
    const { fetch } = recordingFetch(() => streamResponse(halved));
    const events = await drain(
      new GoogleProvider({ apiKey: KEY, fetch }).stream({
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'Look',
      'ing.',
    ]);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(doneOf(events).text).toBe('Looking.');
  });

  it('keeps a thought part out of the answer instead of concatenating them', async () => {
    const { fetch } = recordingFetch(() =>
      streamResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"weighing it","thought":true}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"yes"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}\n\n',
      ]),
    );
    const events = await drain(
      new GoogleProvider({ apiKey: KEY, fetch }).stream({
        model: 'google/gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events.find((e) => e.type === 'thinking_delta')).toMatchObject({ text: 'weighing it' });
    const done = doneOf(events);
    expect(done.text).toBe('yes');
    expect(done.thinking).toBe('weighing it');
  });

  it('aborts on the caller signal rather than draining the stream', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch } = recordingFetch(() => streamResponse(SSE));
    await expect(
      drain(
        new GoogleProvider({ apiKey: KEY, fetch }).stream({
          model: 'google/gemini-2.5-flash',
          messages: [{ role: 'user', content: 'hi' }],
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'E_ABORTED' });
  });

  it('keeps the key out of an error message', async () => {
    const { fetch } = recordingFetch(() => errorResponse(403, { error: { message: `key ${KEY} is bad` } }));
    try {
      await new GoogleProvider({ apiKey: KEY, fetch }).chat({
        model: 'google/gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as HuskError).message).not.toContain(KEY);
    }
  });
});

describe('GoogleProvider.chat', () => {
  const ok = (parts: unknown[], extra: Record<string, unknown> = {}) =>
    jsonResponse({
      candidates: [{ content: { parts }, finishReason: 'STOP', ...extra }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
    });

  it('translates a request into generateContent, not chat/completions', async () => {
    const { fetch, calls } = recordingFetch(() => ok([{ text: 'hello' }]));
    await new GoogleProvider({ apiKey: KEY, fetch }).chat({
      model: 'google/gemini-2.5-pro',
      system: 'be terse',
      temperature: 0.2,
      maxTokens: 512,
      stop: ['END'],
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    expect(calls[0]?.headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0]?.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'be terse' }] },
      generationConfig: { temperature: 0.2, maxOutputTokens: 512, stopSequences: ['END'] },
    });
    // The OpenAI names must not leak into a Gemini body; each one is a 400.
    expect(calls[0]?.body).not.toHaveProperty('messages');
    expect(calls[0]?.body).not.toHaveProperty('max_tokens');
  });

  it('sends tools as functionDeclarations with a Gemini-legal schema', async () => {
    const { fetch, calls } = recordingFetch(() => ok([{ text: 'ok' }]));
    await new GoogleProvider({ apiKey: KEY, fetch }).chat({
      model: 'google/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'run it' }],
      toolChoice: 'required',
      tools: [
        {
          name: 'shell',
          description: 'run a command',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { cmd: { type: 'string', default: 'ls' } },
            required: ['cmd'],
          },
        },
      ],
    });

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['tools']).toEqual([
      {
        functionDeclarations: [
          {
            name: 'shell',
            description: 'run a command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
          },
        ],
      },
    ]);
    expect(body['toolConfig']).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  });

  it('pins a named tool through allowedFunctionNames', async () => {
    const { fetch, calls } = recordingFetch(() => ok([{ text: 'ok' }]));
    await new GoogleProvider({ apiKey: KEY, fetch }).chat({
      model: 'google/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      toolChoice: { name: 'shell' },
      tools: [{ name: 'shell', description: 'run', parameters: { type: 'object' } }],
    });
    expect((calls[0]?.body as Record<string, unknown>)['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['shell'] },
    });
  });

  it('inlines an image as inlineData rather than a data URL', async () => {
    const { fetch, calls } = recordingFetch(() => ok([{ text: 'a cat' }]));
    await new GoogleProvider({ apiKey: KEY, fetch }).chat({
      model: 'google/gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', mimeType: 'image/png', data: 'QUJD' },
          ],
        },
      ],
    });
    const contents = (calls[0]?.body as { contents: Array<{ parts: unknown[] }> }).contents;
    expect(contents[0]?.parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'QUJD' } });
  });

  it('reads a functionCall back out as a tool call with a stable id', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: 'checking' }, { functionCall: { name: 'shell', args: { cmd: 'pwd' } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6 },
      }),
    );
    const response = await new GoogleProvider({ apiKey: KEY, fetch }).chat({
      model: 'google/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'where am i' }],
    });

    expect(response.text).toBe('checking');
    expect(response.toolCalls).toEqual([
      { type: 'tool_call', id: 'gcall_0_shell', name: 'shell', args: { cmd: 'pwd' } },
    ]);
    // Gemini reports STOP even when it asked for a tool; the finish reason has to
    // come from the parts, or the agent loop stops instead of running the tool.
    expect(response.finishReason).toBe('tool_calls');
    expect(response.usage.costUsd).toBeGreaterThan(0);
  });

  it('round-trips a tool result back into the next request', async () => {
    const { fetch, calls } = recordingFetch(() => ok([{ text: '/home' }]));
    await new GoogleProvider({ apiKey: KEY, fetch }).chat({
      model: 'google/gemini-2.5-pro',
      messages: [
        { role: 'user', content: 'where am i' },
        { role: 'assistant', content: [{ type: 'tool_call', id: 'gcall_0_shell', name: 'shell', args: { cmd: 'pwd' } }] },
        { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'gcall_0_shell', content: '/home' }] },
      ],
    });
    expect((calls[0]?.body as { contents: unknown }).contents).toEqual([
      { role: 'user', parts: [{ text: 'where am i' }] },
      { role: 'model', parts: [{ functionCall: { name: 'shell', args: { cmd: 'pwd' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'shell', response: { result: '/home' } } }] },
    ]);
  });

  it('maps the Gemini finish reasons onto ours', async () => {
    for (const [geminiReason, expected] of [
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'content_filter'],
      ['RECITATION', 'content_filter'],
      ['STOP', 'stop'],
    ] as const) {
      const { fetch } = recordingFetch(() =>
        jsonResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: geminiReason }] }),
      );
      const response = await new GoogleProvider({ apiKey: KEY, fetch }).chat({
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.finishReason).toBe(expected);
    }
  });

  it('names GOOGLE_API_KEY when there is no key, and does not pretend to work', async () => {
    const provider = new GoogleProvider({ env: {} });
    const availability = await provider.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('GOOGLE_API_KEY');
    expect(availability.hint).toContain('GOOGLE_API_KEY');
    await expect(
      provider.chat({ model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'E_NO_CREDENTIALS' });
  });

  it('accepts GEMINI_API_KEY too, because that is what aistudio calls it', async () => {
    const provider = new GoogleProvider({ env: { GEMINI_API_KEY: KEY } });
    expect(await provider.isAvailable()).toEqual({ available: true });
  });

  it('prices every catalogued model, so a caller can budget before calling', async () => {
    const models = await new GoogleProvider({ apiKey: KEY }).listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.pricing?.inputPerMTok).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.supportsTools).toBe(true);
    }
  });
});

describe('Gemini content translation', () => {
  it('answers a function call by name, because Gemini has no call ids', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'gcall_0_shell', name: 'shell', args: { cmd: 'pwd' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'gcall_0_shell', content: '/home' }] },
    ]);
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[2]?.parts[0]).toEqual({ functionResponse: { name: 'shell', response: { result: '/home' } } });
  });

  it('recovers the function name from a synthesised id when the call is gone', () => {
    const contents = toGeminiContents([
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'gcall_3_read_file', content: 'x' }] },
    ]);
    expect(contents[0]?.parts[0]).toMatchObject({ functionResponse: { name: 'read_file' } });
  });

  it('renames the assistant role to model', () => {
    expect(toGeminiContents([{ role: 'assistant', content: 'hi' }])[0]?.role).toBe('model');
  });

  it('coalesces adjacent same-role turns', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
    ]);
    expect(contents).toHaveLength(1);
    expect(contents[0]?.parts).toHaveLength(2);
  });
});

describe('geminiSchema', () => {
  it('strips the JSON Schema keywords Gemini rejects', () => {
    const pruned = geminiSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', default: '/tmp', examples: ['/etc'] },
        depth: { type: 'integer', exclusiveMinimum: 0 },
      },
      required: ['path'],
    });
    expect(pruned).toEqual({
      type: 'object',
      properties: { path: { type: 'string' }, depth: { type: 'integer' } },
      required: ['path'],
    });
  });

  it('turns a const into a one-value enum, which Gemini does understand', () => {
    expect(geminiSchema({ type: 'string', const: 'yes' })).toEqual({ type: 'string', enum: ['yes'] });
  });

  it('prunes inside arrays and nested objects', () => {
    const pruned = geminiSchema({
      type: 'array',
      items: { type: 'object', additionalProperties: true, properties: { a: { type: 'string', $id: 'x' } } },
    });
    expect(pruned).toEqual({ type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } });
  });
});
