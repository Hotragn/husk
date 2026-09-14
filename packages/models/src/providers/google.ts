/**
 * Google Gemini.
 *
 * Genuinely a different wire format, not a dialect: `contents` instead of `messages`,
 * `model` instead of `assistant`, function results keyed by **name** rather than by
 * call id, and a JSON Schema subset that rejects half of draft-07. Each of those is a
 * translation this package exists to own, so Gemini gets its own file.
 */

import type {
  ChatRequest,
  ChatResponse,
  ContentPart,
  FinishReason,
  JSONSchema,
  ModelInfo,
  ModelMessage,
  ModelProvider,
  StreamEvent,
  ToolCallPart,
  Usage,
} from '@husk-ai/core';
import { catalogFor, findModel, unknownModel } from '../catalog.js';
import { costOf } from '../cost.js';
import { httpError, jsonHeaders, missingKey, networkError, type ErrorContext } from '../http.js';
import { parseJSON, readSSE } from '../wire.js';
import { bareName, safeText, type FetchLike, type ProviderOptions } from './openai-compatible.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

export class GoogleProvider implements ModelProvider {
  readonly id = 'google';
  readonly displayName = 'Google Gemini';
  readonly priority = 80;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;

  constructor(opts: ProviderOptions = {}) {
    const env = opts.env ?? process.env;
    this.apiKey = opts.apiKey ?? env['GOOGLE_API_KEY'] ?? env['GEMINI_API_KEY'];
    this.baseUrl = (opts.baseUrl ?? env['GOOGLE_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private ctx(model?: string): ErrorContext {
    return {
      provider: this.id,
      displayName: this.displayName,
      envKey: 'GOOGLE_API_KEY',
      ...(model ? { model } : {}),
      ...(this.apiKey ? { secret: this.apiKey } : {}),
    };
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string; hint?: string }> {
    if (this.apiKey) return { available: true };
    return {
      available: false,
      reason: 'GOOGLE_API_KEY is not set',
      hint: 'Set GOOGLE_API_KEY — aistudio.google.com gives a free key with a Gemini Flash free tier.',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return catalogFor(this.id);
  }

  private headers(): Record<string, string> {
    return jsonHeaders({ 'x-goog-api-key': this.apiKey });
  }

  private buildBody(req: ChatRequest, model: string): Record<string, unknown> {
    const info = findModel(`${this.id}/${model}`);
    const body: Record<string, unknown> = { contents: toGeminiContents(req.messages) };

    const system = systemText(req);
    if (system) body['systemInstruction'] = { parts: [{ text: system }] };

    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig['temperature'] = req.temperature;
    if (req.topP !== undefined) generationConfig['topP'] = req.topP;
    if (req.maxTokens) generationConfig['maxOutputTokens'] = req.maxTokens;
    if (req.stop?.length) generationConfig['stopSequences'] = req.stop;
    if (req.responseFormat?.type === 'json') {
      generationConfig['responseMimeType'] = 'application/json';
      if (req.responseFormat.schema) generationConfig['responseSchema'] = geminiSchema(req.responseFormat.schema);
    }
    if (req.thinking?.enabled && info?.supportsThinking) {
      generationConfig['thinkingConfig'] = {
        includeThoughts: true,
        ...(req.thinking.budgetTokens ? { thinkingBudget: req.thinking.budgetTokens } : {}),
      };
    }
    if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;

    if (req.tools?.length) {
      body['tools'] = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: geminiSchema(t.parameters),
          })),
        },
      ];
      if (req.toolChoice) body['toolConfig'] = { functionCallingConfig: toGeminiToolConfig(req.toolChoice) };
    }

    return body;
  }

  private async post(path: string, body: Record<string, unknown>, req: ChatRequest, model: string): Promise<Response> {
    const init: RequestInit = { method: 'POST', headers: this.headers(), body: JSON.stringify(body) };
    if (req.signal) init.signal = req.signal;
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}/${path}`, init);
    } catch (err) {
      throw networkError(this.ctx(model), err);
    }
    if (!res.ok) throw httpError(this.ctx(model), res.status, await safeText(res));
    return res;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = bareName(req.model, this.id);
    if (!this.apiKey) throw missingKey(this.ctx(model));
    const started = Date.now();
    const res = await this.post(`models/${model}:generateContent`, this.buildBody(req, model), req, model);

    let data: GeminiResponse;
    try {
      data = (await res.json()) as GeminiResponse;
    } catch (err) {
      throw networkError(this.ctx(model), err);
    }

    const collected = collect(data.candidates?.[0]?.content?.parts ?? [], 0);
    const usage = this.usageOf(data, model);
    const response: ChatResponse = {
      model: `${this.id}/${model}`,
      text: collected.text,
      toolCalls: collected.calls,
      finishReason: toFinishReason(data.candidates?.[0]?.finishReason, collected.calls.length > 0),
      usage,
      latencyMs: Date.now() - started,
      raw: data,
    };
    if (collected.thinking) response.thinking = collected.thinking;
    return response;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const model = bareName(req.model, this.id);
    if (!this.apiKey) throw missingKey(this.ctx(model));
    const started = Date.now();
    const res = await this.post(
      `models/${model}:streamGenerateContent?alt=sse`,
      this.buildBody(req, model),
      req,
      model,
    );
    if (!res.body) throw networkError(this.ctx(model), new Error('empty response body'));

    yield { type: 'start', model: `${this.id}/${model}` };

    let text = '';
    let thinking = '';
    let finish: FinishReason = 'stop';
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const calls: ToolCallPart[] = [];

    try {
      for await (const frame of readSSE(res.body)) {
        const chunk = parseJSON<GeminiResponse>(frame.data);
        if (!chunk) continue;
        if (chunk.usageMetadata) usage = this.usageOf(chunk, model);
        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.functionCall?.name) {
            const call: ToolCallPart = {
              type: 'tool_call',
              id: synthesiseId(part.functionCall.name, calls.length),
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
            };
            calls.push(call);
            yield { type: 'tool_call', call };
            continue;
          }
          if (typeof part.text !== 'string' || part.text === '') continue;
          if (part.thought) {
            thinking += part.text;
            yield { type: 'thinking_delta', text: part.text };
          } else {
            text += part.text;
            yield { type: 'text_delta', text: part.text };
          }
        }
        if (candidate?.finishReason) finish = toFinishReason(candidate.finishReason, calls.length > 0);
      }
    } catch (err) {
      throw networkError(this.ctx(model), err);
    }

    yield { type: 'usage', usage };

    const response: ChatResponse = {
      model: `${this.id}/${model}`,
      text,
      toolCalls: calls,
      finishReason: finish,
      usage,
      latencyMs: Date.now() - started,
    };
    if (thinking) response.thinking = thinking;
    yield { type: 'done', response };
  }

  private usageOf(data: GeminiResponse, model: string): Usage {
    const info = findModel(`${this.id}/${model}`) ?? unknownModel(this.id, model, false);
    const meta = data.usageMetadata ?? {};
    const cached = meta.cachedContentTokenCount ?? 0;
    const usage: Usage = {
      inputTokens: Math.max(0, (meta.promptTokenCount ?? 0) - cached),
      // Thinking tokens bill as output, and Google reports them separately.
      outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    };
    if (cached) usage.cacheReadTokens = cached;
    usage.costUsd = costOf(info, usage);
    return usage;
  }
}

function collect(parts: GeminiPart[], startIndex: number): { text: string; thinking: string; calls: ToolCallPart[] } {
  let text = '';
  let thinking = '';
  const calls: ToolCallPart[] = [];
  for (const part of parts) {
    if (part.functionCall?.name) {
      calls.push({
        type: 'tool_call',
        id: synthesiseId(part.functionCall.name, startIndex + calls.length),
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
      });
    } else if (typeof part.text === 'string') {
      if (part.thought) thinking += part.text;
      else text += part.text;
    }
  }
  return { text, thinking, calls };
}

/**
 * Gemini has no call ids, but the rest of Husk needs one to pair a result with its
 * call. Encode the function name into the id so the pairing survives a round trip
 * even if the caller loses the original message.
 */
export function synthesiseId(name: string, index: number): string {
  return `gcall_${index}_${name}`;
}

function nameFromSynthesisedId(id: string): string | undefined {
  const m = /^gcall_\d+_(.+)$/.exec(id);
  return m?.[1];
}

function systemText(req: ChatRequest): string {
  const fromMessages = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')));
  return [req.system, ...fromMessages].filter(Boolean).join('\n\n');
}

function partsOf(m: ModelMessage): ContentPart[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
}

export function toGeminiContents(messages: ModelMessage[]): GeminiContent[] {
  // `functionResponse` is keyed by function name, so every result has to be able to
  // find the call it answers. Index the whole conversation first.
  const namesById = new Map<string, string>();
  for (const m of messages) {
    for (const p of partsOf(m)) if (p.type === 'tool_call') namesById.set(p.id, p.name);
  }

  const out: GeminiContent[] = [];
  const push = (role: 'user' | 'model', parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };

  for (const m of messages) {
    if (m.role === 'system') continue;
    const parts: GeminiPart[] = [];
    const results: GeminiPart[] = [];

    for (const p of partsOf(m)) {
      switch (p.type) {
        case 'text':
          if (p.text) parts.push({ text: p.text });
          break;
        case 'image':
          parts.push({ inlineData: { mimeType: p.mimeType, data: p.data } });
          break;
        case 'tool_call':
          parts.push({ functionCall: { name: p.name, args: p.args } });
          break;
        case 'tool_result': {
          const name = namesById.get(p.toolCallId) ?? nameFromSynthesisedId(p.toolCallId) ?? p.toolCallId;
          results.push({
            functionResponse: {
              name,
              response: p.isError ? { error: p.content } : { result: p.content },
            },
          });
          break;
        }
        case 'thinking':
          break;
      }
    }

    if (results.length > 0) push('user', results);
    push(m.role === 'assistant' ? 'model' : 'user', parts);
  }

  return out;
}

function toGeminiToolConfig(choice: NonNullable<ChatRequest['toolChoice']>): Record<string, unknown> {
  if (typeof choice === 'object') return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  if (choice === 'required') return { mode: 'ANY' };
  if (choice === 'none') return { mode: 'NONE' };
  return { mode: 'AUTO' };
}

function toFinishReason(reason: string | undefined, hasCalls: boolean): FinishReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter';
    default:
      return hasCalls ? 'tool_calls' : 'stop';
  }
}

/**
 * Gemini takes an OpenAPI 3 subset, not JSON Schema. Keys it does not know are a 400,
 * so they are stripped rather than passed through and hoped for.
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  'additionalProperties',
  'definitions',
  '$defs',
  'patternProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'const',
  'examples',
  'default',
]);

export function geminiSchema(schema: JSONSchema): JSONSchema {
  return prune(schema) as JSONSchema;
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'const') {
      out['enum'] = [v];
      continue;
    }
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    out[key] = prune(v);
  }
  return out;
}
