/**
 * The model contract.
 *
 * One surface over Anthropic, OpenAI, Google, Groq, OpenRouter, Ollama, LM Studio
 * and anything else that speaks tool-calling chat. Providers translate; callers do not.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image';
  mimeType: string;
  /** base64, with no data: prefix. */
  data: string;
}
export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
}
export interface ThinkingPart {
  type: 'thinking';
  text: string;
  signature?: string;
}

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart | ThinkingPart;

export interface ModelMessage {
  role: Role;
  content: string | ContentPart[];
  /** Present on tool messages so providers that need it can round-trip. */
  name?: string;
}

/** JSON Schema draft-07 subset. Kept loose on purpose, because providers vary. */
export type JSONSchema = Record<string, unknown>;

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface ChatRequest {
  /** An alias (sonnet, gemma) or a fully-qualified id (anthropic/claude-sonnet-5). */
  model: string;
  messages: ModelMessage[];
  system?: string;
  tools?: ToolSchema[];
  toolChoice?: ToolChoice;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  /** Ask for extended reasoning where the provider supports it. */
  thinking?: { enabled: boolean; budgetTokens?: number };
  responseFormat?: { type: 'text' } | { type: 'json'; schema?: JSONSchema };
  signal?: AbortSignal;
  metadata?: Record<string, string>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Zero for local models. Estimated from the price table otherwise. */
  costUsd?: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'aborted';

export interface ChatResponse {
  /** Resolved fully-qualified model id. */
  model: string;
  text: string;
  thinking?: string;
  toolCalls: ToolCallPart[];
  finishReason: FinishReason;
  usage: Usage;
  latencyMs: number;
  raw?: unknown;
  /**
   * Things the caller must know that did not stop the call -- above all, a
   * fallback to a different model than the one requested.
   *
   * The streaming path can emit a `warning` event mid-flight; a single-shot
   * `chat()` has nowhere else to put one, and without this a request for Opus
   * that quietly ran on a 1.5B local model comes back as a plain 200. The
   * substitution is visible in `model`, but only to someone who thought to
   * compare it against what they asked for.
   */
  warnings?: Array<{ message: string; code?: string; detail?: Record<string, unknown> }>;
}

export type StreamEvent =
  | { type: 'start'; model: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ToolCallPart }
  | { type: 'usage'; usage: Usage }
  /**
   * Something the caller must know that did not stop the stream -- most often a
   * fallback to a different model. Silently answering with a weaker model than
   * the one that was asked for is worse than failing, so a router that falls
   * back is required to emit this.
   */
  | { type: 'warning'; message: string; code?: string; detail?: Record<string, unknown> }
  | { type: 'done'; response: ChatResponse }
  | { type: 'error'; error: { message: string; code?: string; retryable?: boolean } };

export interface ModelInfo {
  /** Fully-qualified, as provider slash model. */
  id: string;
  provider: string;
  /** The bare model name the provider expects on the wire. */
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsThinking?: boolean;
  /**
   * USD per million tokens. Absent or zero for local models.
   *
   * `cacheWritePerMTok` is separate because writing a cache entry is not priced
   * as a fraction of input everywhere -- Anthropic charges 1.25x input, others
   * charge nothing. Deriving it from a single global multiplier is wrong for
   * every provider but one.
   */
  pricing?: {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
  };
  /** True when the model can be run at no cost, whether local or on a provider free tier. */
  free?: boolean;
  tags?: string[];
}

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  /** Ordered fallback preference; higher is tried first when a model is ambiguous. */
  readonly priority: number;

  isAvailable(): Promise<{ available: boolean; reason?: string; hint?: string }>;
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

/** Flatten any message content down to plain text. */
export function messageText(m: ModelMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : ''))
    .filter(Boolean)
    .join('\n');
}
