/**
 * Ollama: the free path, and therefore the one that has to be right.
 *
 * Husk promises that with no API key, no Docker and no account, the thing still runs.
 * That promise is this file. `/api/chat` with `stream: true` is newline-delimited
 * JSON rather than SSE, tools are native, and `listModels()` reports what is actually
 * pulled on this machine — never a catalogue of models the user would have to
 * download first.
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
  Usage,
} from '@husk/core';
import { mapLimit } from '@husk/core';
import { findModel } from '../catalog.js';
import { httpError, jsonHeaders, networkError, type ErrorContext } from '../http.js';
import { ToolCallAccumulator, readNDJSON } from '../wire.js';
import { bareName, safeText, type FetchLike, type ProviderOptions } from './openai-compatible.js';

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const PULL_HINT = 'Install Ollama from ollama.com, then run `ollama pull qwen2.5:7b` for a free local model that can call tools.';
/** A local daemon that is mid-start must not stall `husk doctor`. */
const PROBE_TIMEOUT_MS = 2_000;

interface OllamaTag {
  name?: string;
  model?: string;
  details?: { family?: string; parameter_size?: string };
}

interface OllamaChunk {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama';
  /** Below every hosted provider on quality, above all of them on cost. */
  readonly priority = 40;

  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private cache: { at: number; models: ModelInfo[] } | undefined;

  constructor(opts: ProviderOptions = {}) {
    const env = opts.env ?? process.env;
    this.baseUrl = normaliseHost(opts.baseUrl ?? env['OLLAMA_HOST'] ?? DEFAULT_HOST);
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private ctx(model?: string): ErrorContext {
    return { provider: this.id, displayName: this.displayName, ...(model ? { model } : {}) };
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string; hint?: string }> {
    let models: ModelInfo[];
    try {
      models = await this.listModels();
    } catch {
      return { available: false, reason: `no Ollama server at ${this.baseUrl}`, hint: PULL_HINT };
    }
    if (models.length === 0) {
      return {
        available: false,
        reason: 'Ollama is running but has no models pulled',
        hint: 'Run `ollama pull qwen2.5:7b` -- about 4.7 GB, and then Husk works with no API key at all.',
      };
    }
    return { available: true };
  }

  /** What is on disk right now, with the real context window from `/api/show`. */
  async listModels(): Promise<ModelInfo[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.models;

    let tags: OllamaTag[];
    try {
      const res = await this.doFetch(`${this.baseUrl}/api/tags`, {
        headers: jsonHeaders({}),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) throw httpError(this.ctx(), res.status, await safeText(res));
      const body = (await res.json()) as { models?: OllamaTag[] };
      tags = body.models ?? [];
    } catch (err) {
      throw networkError(this.ctx(), err);
    }

    const names = tags.map((t) => t.model ?? t.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
    const details = await mapLimit(names, 4, async (name) => this.show(name));

    const models: ModelInfo[] = names.map((name, i) => {
      const tag = tags[i];
      const shown = details[i];
      const known = findModel(`ollama/${stripLatest(name)}`);
      return {
        id: `ollama/${name}`,
        provider: 'ollama',
        name,
        displayName: `${name} (local)`,
        contextWindow: shown?.contextWindow ?? known?.contextWindow ?? 8_192,
        maxOutputTokens: Math.min(shown?.contextWindow ?? known?.contextWindow ?? 8_192, 8_192),
        supportsTools: shown?.supportsTools ?? known?.supportsTools ?? true,
        supportsVision: shown?.supportsVision ?? known?.supportsVision ?? false,
        supportsStreaming: true,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        free: true,
        tags: ['local', ...(tag?.details?.family ? [tag.details.family] : [])],
      };
    });

    this.cache = { at: Date.now(), models };
    return models;
  }

  /** `/api/show` knows the real context length and whether the model does tools. */
  private async show(name: string): Promise<{ contextWindow?: number; supportsTools?: boolean; supportsVision?: boolean } | undefined> {
    try {
      const res = await this.doFetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: jsonHeaders({}),
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        model_info?: Record<string, unknown>;
        capabilities?: string[];
      };
      const contextKey = Object.keys(body.model_info ?? {}).find((k) => k.endsWith('.context_length'));
      const raw = contextKey ? body.model_info?.[contextKey] : undefined;
      const caps = body.capabilities ?? [];
      const out: { contextWindow?: number; supportsTools?: boolean; supportsVision?: boolean } = {};
      if (typeof raw === 'number' && raw > 0) out.contextWindow = raw;
      if (caps.length > 0) {
        out.supportsTools = caps.includes('tools');
        out.supportsVision = caps.includes('vision');
      }
      return out;
    } catch {
      return undefined;
    }
  }

  private buildBody(req: ChatRequest, model: string): Record<string, unknown> {
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options['temperature'] = req.temperature;
    if (req.topP !== undefined) options['top_p'] = req.topP;
    if (req.maxTokens) options['num_predict'] = req.maxTokens;
    if (req.stop?.length) options['stop'] = req.stop;

    const body: Record<string, unknown> = {
      model,
      messages: toOllamaMessages(req.messages, req.system),
      stream: false,
    };
    if (Object.keys(options).length > 0) body['options'] = options;
    if (req.thinking?.enabled) body['think'] = true;
    if (req.tools?.length) {
      body['tools'] = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.responseFormat?.type === 'json') {
      body['format'] = req.responseFormat.schema ?? 'json';
    }
    return body;
  }

  private async post(body: Record<string, unknown>, req: ChatRequest, model: string): Promise<Response> {
    const init: RequestInit = { method: 'POST', headers: jsonHeaders({}), body: JSON.stringify(body) };
    if (req.signal) init.signal = req.signal;
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}/api/chat`, init);
    } catch (err) {
      throw networkError(this.ctx(model), err);
    }
    if (!res.ok) throw httpError(this.ctx(model), res.status, await safeText(res));
    return res;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = bareName(req.model, this.id);
    const started = Date.now();
    const res = await this.post(this.buildBody(req, model), req, model);

    let data: OllamaChunk;
    try {
      data = (await res.json()) as OllamaChunk;
    } catch (err) {
      throw networkError(this.ctx(model), err);
    }

    const toolCalls = readToolCalls(data, new ToolCallAccumulator());
    const response: ChatResponse = {
      model: `${this.id}/${model}`,
      text: data.message?.content ?? '',
      toolCalls,
      finishReason: toFinishReason(data.done_reason, toolCalls.length > 0),
      usage: usageOf(data),
      latencyMs: Date.now() - started,
      raw: data,
    };
    if (data.message?.thinking) response.thinking = data.message.thinking;
    return response;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const model = bareName(req.model, this.id);
    const started = Date.now();
    const body = this.buildBody(req, model);
    body['stream'] = true;

    const res = await this.post(body, req, model);
    if (!res.body) throw networkError(this.ctx(model), new Error('empty response body'));

    yield { type: 'start', model: `${this.id}/${model}` };

    const calls = new ToolCallAccumulator();
    const emitted: ToolCallPart[] = [];
    let text = '';
    let thinking = '';
    let finish: FinishReason = 'stop';
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

    try {
      for await (const chunk of readNDJSON<OllamaChunk>(res.body)) {
        if (chunk.message?.content) {
          text += chunk.message.content;
          yield { type: 'text_delta', text: chunk.message.content };
        }
        if (chunk.message?.thinking) {
          thinking += chunk.message.thinking;
          yield { type: 'thinking_delta', text: chunk.message.thinking };
        }
        for (const call of readToolCalls(chunk, calls)) {
          emitted.push(call);
          yield { type: 'tool_call', call };
        }
        if (chunk.done) {
          finish = toFinishReason(chunk.done_reason, emitted.length > 0);
          usage = usageOf(chunk);
        }
      }
    } catch (err) {
      throw networkError(this.ctx(model), err);
    }

    for (const call of calls.flush()) {
      emitted.push(call);
      yield { type: 'tool_call', call };
    }

    yield { type: 'usage', usage };

    const response: ChatResponse = {
      model: `${this.id}/${model}`,
      text,
      toolCalls: emitted,
      finishReason: finish,
      usage,
      latencyMs: Date.now() - started,
    };
    if (thinking) response.thinking = thinking;
    yield { type: 'done', response };
  }
}

/** A local model costs nothing, and saying so explicitly beats an absent field. */
function usageOf(chunk: OllamaChunk): Usage {
  return {
    inputTokens: chunk.prompt_eval_count ?? 0,
    outputTokens: chunk.eval_count ?? 0,
    costUsd: 0,
  };
}

/**
 * Ollama has shipped two shapes for tool-call arguments: a decoded object (most
 * models) and a partial JSON string (models served through its OpenAI-style
 * templating). Handle both, and only surface a call whose arguments are complete.
 */
function readToolCalls(chunk: OllamaChunk, calls: ToolCallAccumulator): ToolCallPart[] {
  const out: ToolCallPart[] = [];
  const list = chunk.message?.tool_calls ?? [];
  for (const [i, tc] of list.entries()) {
    const name = tc.function?.name;
    if (!name) continue;
    const args = tc.function?.arguments;
    if (typeof args === 'string') {
      const ready = calls.push(`${name}:${i}`, { name, argsFragment: args });
      if (ready) out.push(ready);
      continue;
    }
    out.push({
      type: 'tool_call',
      id: `call_${name}_${i}`,
      name,
      args: (args as Record<string, unknown>) ?? {},
    });
  }
  return out;
}

function toFinishReason(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (reason === 'length') return 'length';
  if (hasToolCalls) return 'tool_calls';
  return 'stop';
}

function partsOf(m: ModelMessage): ContentPart[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
}

export function toOllamaMessages(messages: ModelMessage[], system?: string): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    const parts = partsOf(m);
    const results = parts.filter((p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result');
    for (const r of results) {
      out.push({ role: 'tool', content: r.isError ? `ERROR: ${r.content}` : r.content });
    }
    if (m.role === 'tool') continue;

    const text = parts
      .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    const images = parts
      .filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image')
      .map((p) => p.data);
    const calls = parts
      .filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
      .map((p) => ({ function: { name: p.name, arguments: p.args } }));

    if (!text && images.length === 0 && calls.length === 0) continue;
    const msg: Record<string, unknown> = { role: m.role, content: text };
    if (images.length > 0) msg['images'] = images;
    if (calls.length > 0) msg['tool_calls'] = calls;
    out.push(msg);
  }

  return out;
}

/** `OLLAMA_HOST` is routinely set to `localhost:11434` with no scheme. */
function normaliseHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function stripLatest(name: string): string {
  return name.endsWith(':latest') ? name.slice(0, -':latest'.length) : name;
}
