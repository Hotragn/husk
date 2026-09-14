/**
 * The `/v1/chat/completions` dialect, once.
 *
 * Groq, OpenRouter, Together, DeepSeek, Mistral, Cerebras and LM Studio all speak
 * OpenAI's wire format with a different base URL, a different environment variable
 * and a different catalogue. Those are configuration, so they are configuration —
 * see `compatible.ts`. OpenAI itself is this class plus the handful of quirks its own
 * models have, in `openai.ts`.
 */

import type {
  ChatRequest,
  ChatResponse,
  ContentPart,
  FinishReason,
  ModelInfo,
  ModelMessage,
  ModelProvider,
  StreamEvent,
  ToolCallPart,
  ToolSchema,
  Usage,
} from '@husk/core';
import { catalogFor, findModel, unknownModel, type CatalogModel } from '../catalog.js';
import { costOf } from '../cost.js';
import { httpError, jsonHeaders, missingKey, networkError, type ErrorContext } from '../http.js';
import { ToolCallAccumulator, parseJSON, readSSE } from '../wire.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** How long a keyless local server gets to answer a reachability probe. */
const PROBE_TIMEOUT_MS = 2_000;

export interface OpenAICompatibleConfig {
  id: string;
  displayName: string;
  /** Higher is tried first by the router's quality ordering. */
  priority: number;
  /** Root of the OpenAI-shaped API, without a trailing slash: `.../v1`. */
  baseUrl: string;
  /** Environment variable holding the credential. Absent for keyless local servers. */
  envKey?: string;
  /** Environment variable that overrides `baseUrl`, for self-hosted servers. */
  hostEnvKey?: string;
  /** Extra headers this gateway wants (OpenRouter's attribution pair, for one). */
  headers?: Record<string, string>;
  /** Ask the server what it has instead of trusting the static catalog. */
  discover?: boolean;
  /** Everything this provider serves is free. True for LM Studio. */
  alwaysFree?: boolean;
  /**
   * Suffix that marks a zero-cost variant of a model. OpenRouter appends `:free`,
   * and that suffix is the whole signal: `deepseek/deepseek-chat` bills and
   * `deepseek/deepseek-chat:free` does not. Without this, a model discovered from
   * `/models` is priced as if it cost money, and `--model free` never picks it.
   */
  freeSuffix?: string;
  /** Send `stream_options.include_usage`. Off for servers that reject unknown fields. */
  streamUsage?: boolean;
  /** What to tell the user when the credential is missing. */
  hint?: string;
}

export interface ProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
}

interface OAToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OAChunk {
  choices?: Array<{
    index?: number;
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: OAToolCallDelta[] };
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly priority: number;

  protected readonly config: OpenAICompatibleConfig;
  protected readonly baseUrl: string;
  protected readonly apiKey: string | undefined;
  protected readonly doFetch: FetchLike;
  private discovered: ModelInfo[] | undefined;

  constructor(config: OpenAICompatibleConfig, opts: ProviderOptions = {}) {
    const env = opts.env ?? process.env;
    this.config = config;
    this.id = config.id;
    this.displayName = config.displayName;
    this.priority = config.priority;
    this.apiKey = opts.apiKey ?? (config.envKey ? env[config.envKey] : undefined);
    const hostOverride = config.hostEnvKey ? env[config.hostEnvKey] : undefined;
    this.baseUrl = (opts.baseUrl ?? hostOverride ?? config.baseUrl).replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  protected ctx(model?: string): ErrorContext {
    return {
      provider: this.id,
      displayName: this.displayName,
      ...(model ? { model } : {}),
      ...(this.config.envKey ? { envKey: this.config.envKey } : {}),
      ...(this.apiKey ? { secret: this.apiKey } : {}),
    };
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string; hint?: string }> {
    if (this.config.envKey && !this.apiKey) {
      return {
        available: false,
        reason: `${this.config.envKey} is not set`,
        hint: this.config.hint ?? `Set ${this.config.envKey} to use ${this.displayName}.`,
      };
    }
    if (!this.config.envKey) {
      // A keyless local server is only usable if it is actually listening.
      try {
        // A local server that is starting up must not stall `husk doctor`.
        const res = await this.doFetch(`${this.baseUrl}/models`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.ok) return { available: true };
        return {
          available: false,
          reason: `${this.baseUrl} answered ${res.status}`,
          hint: this.config.hint ?? `Start ${this.displayName} and load a model.`,
        };
      } catch {
        return {
          available: false,
          reason: `${this.baseUrl} is not listening`,
          hint: this.config.hint ?? `Start ${this.displayName} (expected at ${this.baseUrl}).`,
        };
      }
    }
    return { available: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    const staticModels = catalogFor(this.id);
    if (!this.config.discover) return staticModels;
    if (this.discovered) return this.discovered;
    try {
      const res = await this.doFetch(`${this.baseUrl}/models`, { headers: this.headers() });
      if (!res.ok) return staticModels;
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const live = (body.data ?? [])
        .map((m) => m.id)
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
        .map((name) => findModel(`${this.id}/${name}`) ?? unknownModel(this.id, name, this.isFreeModel(name)));
      const merged = new Map<string, ModelInfo>(staticModels.map((m) => [m.id, m]));
      for (const m of live) merged.set(m.id, m);
      this.discovered = [...merged.values()];
      return this.discovered;
    } catch {
      return staticModels;
    }
  }

  protected info(name: string): CatalogModel {
    return findModel(`${this.id}/${name}`) ?? unknownModel(this.id, name, this.isFreeModel(name));
  }

  /** Whether this gateway serves this particular model at no cost. */
  protected isFreeModel(name: string): boolean {
    if (this.config.alwaysFree === true) return true;
    const suffix = this.config.freeSuffix;
    return suffix !== undefined && name.endsWith(suffix);
  }

  protected headers(): Record<string, string> {
    return jsonHeaders({
      ...(this.config.headers ?? {}),
      authorization: this.apiKey ? `Bearer ${this.apiKey}` : undefined,
    });
  }

  /** Model-specific wire quirks. Overridden by `openai.ts` for the o-series. */
  protected tuneBody(body: Record<string, unknown>, _req: ChatRequest): Record<string, unknown> {
    return body;
  }

  protected buildBody(req: ChatRequest, model: string): Record<string, unknown> {
    const messages = toOpenAIMessages(req.messages, req.system);
    const body: Record<string, unknown> = { model, messages };

    if (req.maxTokens) body['max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.stop?.length) body['stop'] = req.stop;
    if (req.tools?.length) body['tools'] = toOpenAITools(req.tools);
    if (req.toolChoice && req.tools?.length) body['tool_choice'] = toOpenAIToolChoice(req.toolChoice);

    if (req.responseFormat?.type === 'json') {
      body['response_format'] = req.responseFormat.schema
        ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: req.responseFormat.schema } }
        : { type: 'json_object' };
    }

    return this.tuneBody(body, req);
  }

  private async post(body: Record<string, unknown>, req: ChatRequest, model: string): Promise<Response> {
    const init: RequestInit = {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    };
    if (req.signal) init.signal = req.signal;
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}/chat/completions`, init);
    } catch (err) {
      throw networkError(this.ctx(model), err);
    }
    if (!res.ok) throw httpError(this.ctx(model), res.status, await safeText(res));
    return res;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = bareName(req.model, this.id);
    if (this.config.envKey && !this.apiKey) throw missingKey(this.ctx(model));
    const started = Date.now();
    const res = await this.post(this.buildBody(req, model), req, model);

    let data: OAChunk;
    try {
      data = (await res.json()) as OAChunk;
    } catch (err) {
      throw networkError(this.ctx(model), err);
    }

    const choice = data.choices?.[0];
    const message = choice?.message;
    const toolCalls: ToolCallPart[] = [];
    for (const [i, tc] of (message?.tool_calls ?? []).entries()) {
      toolCalls.push({
        type: 'tool_call',
        id: tc.id ?? `call_${i}`,
        name: tc.function?.name ?? '',
        args: parseJSON<Record<string, unknown>>(tc.function?.arguments ?? '{}') ?? {},
      });
    }

    const usage = this.usageOf(data, model);
    const response: ChatResponse = {
      model: `${this.id}/${model}`,
      text: message?.content ?? '',
      toolCalls,
      finishReason: toFinishReason(choice?.finish_reason, toolCalls.length > 0),
      usage,
      latencyMs: Date.now() - started,
      raw: data,
    };
    if (message?.reasoning_content) response.thinking = message.reasoning_content;
    return response;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const model = bareName(req.model, this.id);
    if (this.config.envKey && !this.apiKey) throw missingKey(this.ctx(model));
    const started = Date.now();
    const body = this.buildBody(req, model);
    body['stream'] = true;
    if (this.config.streamUsage !== false) body['stream_options'] = { include_usage: true };

    const res = await this.post(body, req, model);
    if (!res.body) throw networkError(this.ctx(model), new Error('empty response body'));

    yield { type: 'start', model: `${this.id}/${model}` };

    const calls = new ToolCallAccumulator();
    let text = '';
    let thinking = '';
    let finish: FinishReason | undefined;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const emitted: ToolCallPart[] = [];

    try {
      for await (const frame of readSSE(res.body)) {
        const chunk = parseJSON<OAChunk>(frame.data);
        if (!chunk) continue;
        if (chunk.usage) usage = this.usageOf(chunk, model);
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }
        if (delta?.reasoning_content) {
          thinking += delta.reasoning_content;
          yield { type: 'thinking_delta', text: delta.reasoning_content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = tc.index ?? tc.id ?? 0;
          const ready = calls.push(slot, {
            ...(tc.id ? { id: tc.id } : {}),
            ...(tc.function?.name ? { name: tc.function.name } : {}),
            ...(tc.function?.arguments ? { argsFragment: tc.function.arguments } : {}),
          });
          if (ready) {
            emitted.push(ready);
            yield { type: 'tool_call', call: ready };
          }
        }
        if (choice.finish_reason) finish = toFinishReason(choice.finish_reason, calls.size > 0);
      }
    } catch (err) {
      // `networkError` maps an AbortError to E_ABORTED, which the router never retries.
      throw networkError(this.ctx(model), err);
    }

    for (const call of calls.flush()) {
      emitted.push(call);
      yield { type: 'tool_call', call };
    }

    if (usage.inputTokens || usage.outputTokens) yield { type: 'usage', usage };

    const response: ChatResponse = {
      model: `${this.id}/${model}`,
      text,
      toolCalls: emitted,
      finishReason: finish ?? (emitted.length > 0 ? 'tool_calls' : 'stop'),
      usage,
      latencyMs: Date.now() - started,
    };
    if (thinking) response.thinking = thinking;
    yield { type: 'done', response };
  }

  private usageOf(data: OAChunk, model: string): Usage {
    const info = this.info(model);
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: Usage = {
      inputTokens: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached),
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
    if (cached) usage.cacheReadTokens = cached;
    usage.costUsd = costOf(info, usage);
    return usage;
  }
}

export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Strip a `provider/` prefix if the caller left one on. Keeps inner slashes. */
export function bareName(model: string, providerId: string): string {
  return model.startsWith(`${providerId}/`) ? model.slice(providerId.length + 1) : model;
}

export function toFinishReason(reason: string | null | undefined, hasToolCalls: boolean): FinishReason {
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return hasToolCalls ? 'tool_calls' : 'stop';
  }
}

export function toOpenAITools(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function toOpenAIToolChoice(choice: NonNullable<ChatRequest['toolChoice']>): unknown {
  if (typeof choice === 'object') return { type: 'function', function: { name: choice.name } };
  return choice;
}

function partsOf(m: ModelMessage): ContentPart[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
}

/**
 * Husk's message shape carries tool results as parts of whatever message produced
 * them, the way Anthropic models a conversation. OpenAI wants a separate `tool`
 * message per result, so one message in can be several messages out.
 */
export function toOpenAIMessages(messages: ModelMessage[], system?: string): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    const parts = partsOf(m);
    const results = parts.filter((p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result');
    for (const r of results) {
      out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `ERROR: ${r.content}` : r.content });
    }

    if (m.role === 'tool') continue;

    const calls = parts.filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call');
    const texts = parts.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text');
    const images = parts.filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image');

    if (m.role === 'assistant') {
      if (texts.length === 0 && calls.length === 0) continue;
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: texts.map((t) => t.text).join('\n') || null,
      };
      if (calls.length > 0) {
        msg['tool_calls'] = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
      }
      out.push(msg);
      continue;
    }

    if (texts.length === 0 && images.length === 0) continue;
    if (images.length === 0) {
      out.push({ role: m.role, content: texts.map((t) => t.text).join('\n') });
      continue;
    }
    out.push({
      role: m.role,
      content: [
        ...texts.map((t) => ({ type: 'text', text: t.text })),
        ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
      ],
    });
  }

  return out;
}
