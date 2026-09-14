/**
 * Anthropic's Messages API.
 *
 * Three things here are not shared with the OpenAI dialect and are the reason this
 * file exists: tool results ride inside a `user` message rather than a `tool` role,
 * extended thinking is a first-class content block with a signature that must be
 * echoed back verbatim, and prompt caching is opt-in per content block.
 *
 * Caching is placed on exactly two blocks — the system prompt and the last *stable*
 * user turn — because every `cache_control` marker costs a cache write, and marking
 * the newest turn caches a prefix that will never be seen again.
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
} from '@husk-ai/core';
import { HuskError } from '@husk-ai/core';
import { catalogFor, findModel, unknownModel } from '../catalog.js';
import { costOf } from '../cost.js';
import { httpError, jsonHeaders, missingKey, networkError, type ErrorContext } from '../http.js';
import { ToolCallAccumulator, parseJSON, readSSE } from '../wire.js';
import { bareName, safeText, type FetchLike, type ProviderOptions } from './openai-compatible.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const CACHE_CONTROL = { type: 'ephemeral' as const };

type Block = Record<string, unknown>;

interface WireMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly priority = 95;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;

  constructor(opts: ProviderOptions = {}) {
    const env = opts.env ?? process.env;
    this.apiKey = opts.apiKey ?? env['ANTHROPIC_API_KEY'];
    this.baseUrl = (opts.baseUrl ?? env['ANTHROPIC_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private ctx(model?: string): ErrorContext {
    return {
      provider: this.id,
      displayName: this.displayName,
      envKey: 'ANTHROPIC_API_KEY',
      ...(model ? { model } : {}),
      ...(this.apiKey ? { secret: this.apiKey } : {}),
    };
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string; hint?: string }> {
    if (this.apiKey) return { available: true };
    return {
      available: false,
      reason: 'ANTHROPIC_API_KEY is not set',
      hint: 'Set ANTHROPIC_API_KEY for Claude, or run `ollama pull qwen2.5:7b` for a free local model that can call tools.',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return catalogFor(this.id);
  }

  private headers(): Record<string, string> {
    return jsonHeaders({
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    });
  }

  private buildBody(req: ChatRequest, model: string): Record<string, unknown> {
    const info = findModel(`${this.id}/${model}`);
    const messages = toAnthropicMessages(req.messages);
    withPromptCaching(messages);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: req.maxTokens ?? Math.min(info?.maxOutputTokens ?? 8_192, 8_192),
    };

    const system = systemText(req);
    if (system) body['system'] = [{ type: 'text', text: system, cache_control: CACHE_CONTROL }];
    if (req.stop?.length) body['stop_sequences'] = req.stop;

    if (req.thinking?.enabled) {
      const budget = Math.max(1_024, req.thinking.budgetTokens ?? 4_096);
      body['thinking'] = { type: 'enabled', budget_tokens: budget };
      // The API rejects a thinking request whose output allowance cannot hold the
      // reasoning, and rejects any sampling override while thinking is on.
      body['max_tokens'] = Math.max(Number(body['max_tokens']), budget + 1_024);
    } else {
      if (req.temperature !== undefined) body['temperature'] = req.temperature;
      if (req.topP !== undefined) body['top_p'] = req.topP;
    }

    if (req.tools?.length) {
      body['tools'] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      if (req.toolChoice) body['tool_choice'] = toAnthropicToolChoice(req.toolChoice);
    }

    if (req.responseFormat?.type === 'json' && !req.tools?.length) {
      // Anthropic has no JSON mode; the documented technique is an assistant prefill.
      messages.push({ role: 'assistant', content: [{ type: 'text', text: '{' }] });
    }

    return body;
  }

  private async post(body: Record<string, unknown>, req: ChatRequest, model: string): Promise<Response> {
    const init: RequestInit = { method: 'POST', headers: this.headers(), body: JSON.stringify(body) };
    if (req.signal) init.signal = req.signal;
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}/messages`, init);
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
    const res = await this.post(this.buildBody(req, model), req, model);

    let data: {
      content?: Array<Record<string, unknown>>;
      stop_reason?: string;
      usage?: Record<string, number>;
    };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      throw networkError(this.ctx(model), err);
    }

    let text = '';
    let thinking = '';
    const toolCalls: ToolCallPart[] = [];
    for (const block of data.content ?? []) {
      if (block['type'] === 'text') text += String(block['text'] ?? '');
      else if (block['type'] === 'thinking') thinking += String(block['thinking'] ?? '');
      else if (block['type'] === 'tool_use') {
        toolCalls.push({
          type: 'tool_call',
          id: String(block['id'] ?? ''),
          name: String(block['name'] ?? ''),
          args: (block['input'] as Record<string, unknown>) ?? {},
        });
      }
    }

    const usage = this.usageOf(data.usage, model);
    const response: ChatResponse = {
      model: `${this.id}/${model}`,
      text,
      toolCalls,
      finishReason: toFinishReason(data.stop_reason),
      usage,
      latencyMs: Date.now() - started,
      raw: data,
    };
    if (thinking) response.thinking = thinking;
    return response;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const model = bareName(req.model, this.id);
    if (!this.apiKey) throw missingKey(this.ctx(model));
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
    let raw: Record<string, number> = {};

    try {
      for await (const frame of readSSE(res.body)) {
        const event = parseJSON<Record<string, any>>(frame.data);
        if (!event) continue;
        const type = frame.event ?? String(event['type'] ?? '');

        if (type === 'error') {
          throw anthropicStreamError(this.ctx(model), event['error']);
        }
        if (type === 'message_start') {
          raw = { ...raw, ...(event['message']?.usage ?? {}) };
          continue;
        }
        if (type === 'content_block_start') {
          const block = event['content_block'] ?? {};
          if (block.type === 'tool_use') {
            calls.push(Number(event['index'] ?? 0), { id: String(block.id), name: String(block.name) });
          }
          continue;
        }
        if (type === 'content_block_delta') {
          const index = Number(event['index'] ?? 0);
          const delta = event['delta'] ?? {};
          if (delta.type === 'text_delta' && delta.text) {
            text += delta.text;
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            thinking += delta.thinking;
            yield { type: 'thinking_delta', text: delta.thinking };
          } else if (delta.type === 'input_json_delta') {
            const ready = calls.push(index, { argsFragment: String(delta.partial_json ?? '') });
            if (ready) {
              emitted.push(ready);
              yield { type: 'tool_call', call: ready };
            }
          }
          continue;
        }
        if (type === 'content_block_stop') {
          const ready = calls.close(Number(event['index'] ?? 0));
          if (ready) {
            emitted.push(ready);
            yield { type: 'tool_call', call: ready };
          }
          continue;
        }
        if (type === 'message_delta') {
          if (event['delta']?.stop_reason) finish = toFinishReason(event['delta'].stop_reason);
          raw = { ...raw, ...(event['usage'] ?? {}) };
        }
      }
    } catch (err) {
      if (err instanceof HuskError) throw err;
      throw networkError(this.ctx(model), err);
    }

    for (const call of calls.flush()) {
      emitted.push(call);
      yield { type: 'tool_call', call };
    }

    const usage = this.usageOf(raw, model);
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

  private usageOf(raw: Record<string, number> | undefined, model: string): Usage {
    const info = findModel(`${this.id}/${model}`) ?? unknownModel(this.id, model, false);
    const usage: Usage = {
      inputTokens: raw?.['input_tokens'] ?? 0,
      outputTokens: raw?.['output_tokens'] ?? 0,
    };
    const read = raw?.['cache_read_input_tokens'] ?? 0;
    const write = raw?.['cache_creation_input_tokens'] ?? 0;
    if (read) usage.cacheReadTokens = read;
    if (write) usage.cacheWriteTokens = write;
    usage.costUsd = costOf(info, usage);
    return usage;
  }
}

function systemText(req: ChatRequest): string {
  const fromMessages = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : partsToText(m.content)))
    .filter(Boolean);
  return [req.system, ...fromMessages].filter(Boolean).join('\n\n');
}

function partsToText(parts: ContentPart[]): string {
  return parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : ''))
    .filter(Boolean)
    .join('\n');
}

function partsOf(m: ModelMessage): ContentPart[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
}

export function toAnthropicToolChoice(choice: NonNullable<ChatRequest['toolChoice']>): unknown {
  if (typeof choice === 'object') return { type: 'tool', name: choice.name };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  return { type: 'auto' };
}

export function toFinishReason(stop: string | undefined): FinishReason {
  switch (stop) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Translate to Anthropic's shape, then coalesce: the API requires alternating roles,
 * and both `fitContext`'s elision note and a multi-tool turn naturally produce two
 * adjacent messages with the same role.
 */
export function toAnthropicMessages(messages: ModelMessage[]): WireMessage[] {
  const out: WireMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') continue;
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks: Block[] = [];

    for (const p of partsOf(m)) {
      switch (p.type) {
        case 'text':
          if (p.text) blocks.push({ type: 'text', text: p.text });
          break;
        case 'image':
          blocks.push({ type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } });
          break;
        case 'tool_call':
          blocks.push({ type: 'tool_use', id: p.id, name: p.name, input: p.args });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: p.toolCallId,
            content: p.content,
            ...(p.isError ? { is_error: true } : {}),
          });
          break;
        case 'thinking':
          // A thinking block without its signature is rejected on replay, so a
          // signature-less one is dropped rather than sent and refused.
          if (p.signature) blocks.push({ type: 'thinking', thinking: p.text, signature: p.signature });
          break;
      }
    }

    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }

  return out;
}

/**
 * Mark the two cache breakpoints. The system block is handled by the caller; here we
 * mark the last user turn that is *not* the newest one, so the cached prefix survives
 * into the next request instead of being written once and never read.
 */
export function withPromptCaching(messages: WireMessage[]): WireMessage[] {
  const userIndexes = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i !== -1);
  if (userIndexes.length < 2) return messages;
  const stable = userIndexes[userIndexes.length - 2]!;
  const blocks = messages[stable]!.content;
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock) lastBlock['cache_control'] = CACHE_CONTROL;
  return messages;
}

function anthropicStreamError(ctx: ErrorContext, error: unknown): HuskError {
  const e = (error ?? {}) as { type?: string; message?: string };
  const retryable = e.type === 'overloaded_error' || e.type === 'api_error' || e.type === 'rate_limit_error';
  return new HuskError('E_MODEL_ERROR', `Anthropic stream failed: ${e.type ?? 'error'} ${e.message ?? ''}`.trim(), {
    hint: retryable
      ? 'Anthropic is overloaded. Husk will retry, then fall back to the next provider.'
      : 'The request was rejected mid-stream; check the tool schemas and message ordering.',
    details: { provider: ctx.provider, retryable, model: ctx.model },
  });
}
