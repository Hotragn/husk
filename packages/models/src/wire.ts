/**
 * Byte-level wire helpers shared by every provider.
 *
 * These are deliberately free of `fetch` so they can be exercised against inline
 * string fixtures: a stream parser that is only ever tested through the network is
 * a stream parser that is never tested.
 */

import type { ToolCallPart } from '@husk-ai/core';

export type ByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/** Turn a string into a byte source, optionally split at arbitrary boundaries. */
export function bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield encoder.encode(c);
    },
  };
}

async function* iterate(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<Uint8Array>;
    return;
  }
  // Node 20's fetch bodies are async-iterable, but the DOM type is not, and some
  // polyfills only implement the reader. Support both rather than guess.
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Complete lines, as they arrive. A line is only yielded once its terminator has
 * been seen, so a token split across two TCP segments is never emitted twice.
 */
export async function* readLines(source: ByteSource): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of iterate(source)) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      nl = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
}

export interface SSEFrame {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Server-sent events, per the WHATWG rules that actually matter here: frames end at
 * a blank line, `data:` accumulates across lines joined by `\n`, and one leading
 * space after the colon is stripped. Anthropic sends `event:` names; OpenAI does not.
 */
export async function* readSSE(source: ByteSource): AsyncGenerator<SSEFrame> {
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];

  const flush = (): SSEFrame | undefined => {
    if (data.length === 0 && event === undefined) return undefined;
    const frame: SSEFrame = { data: data.join('\n') };
    if (event !== undefined) frame.event = event;
    if (id !== undefined) frame.id = id;
    event = undefined;
    id = undefined;
    data = [];
    return frame;
  };

  for await (const line of readLines(source)) {
    if (line === '') {
      const frame = flush();
      if (frame) yield frame;
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }
  const tail = flush();
  if (tail) yield tail;
}

/** Newline-delimited JSON, as Ollama's `/api/chat` speaks it. Blank lines are skipped. */
export async function* readNDJSON<T = unknown>(source: ByteSource): AsyncGenerator<T> {
  for await (const line of readLines(source)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      // A truncated final line is the only way to get here; there is nothing to do
      // with half a JSON object except drop it.
    }
  }
}

/** Parse a frame body, tolerating the `[DONE]` sentinel and anything malformed. */
export function parseJSON<T = unknown>(text: string): T | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed === '[DONE]') return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
  emitted: boolean;
}

/**
 * Tool-call arguments arrive as partial JSON, split at bytes the provider picked for
 * its own reasons: `{"pa`, `th": "/e`, `tc"}`. Every provider does it, none of them
 * agree on how the fragments are keyed, and `JSON.parse` of a prefix throws.
 *
 * Accumulate per slot, and only surface a call once the accumulated text is a
 * complete JSON value. `flush()` closes out anything the provider never finished.
 */
export class ToolCallAccumulator {
  private readonly slots = new Map<string | number, PendingCall>();
  private order: Array<string | number> = [];
  private counter = 0;

  /** Open or update a slot. Returns the call if its arguments just became parseable. */
  push(
    slot: string | number,
    part: { id?: string; name?: string; argsFragment?: string },
  ): ToolCallPart | undefined {
    let pending = this.slots.get(slot);
    if (!pending) {
      pending = { id: part.id ?? `call_${++this.counter}`, name: part.name ?? '', args: '', emitted: false };
      this.slots.set(slot, pending);
      this.order.push(slot);
    }
    if (part.id) pending.id = part.id;
    if (part.name) pending.name = part.name;
    if (part.argsFragment) pending.args += part.argsFragment;
    return this.ready(pending);
  }

  /** Force a slot closed, e.g. on Anthropic's `content_block_stop`. */
  close(slot: string | number): ToolCallPart | undefined {
    const pending = this.slots.get(slot);
    if (!pending) return undefined;
    const call = this.ready(pending);
    if (call) return call;
    if (pending.emitted || !pending.name) return undefined;
    pending.emitted = true;
    return { type: 'tool_call', id: pending.id, name: pending.name, args: {} };
  }

  /** Everything still open at end of stream, arguments best-effort. */
  flush(): ToolCallPart[] {
    const out: ToolCallPart[] = [];
    for (const slot of this.order) {
      const call = this.close(slot);
      if (call) out.push(call);
    }
    return out;
  }

  get size(): number {
    return this.slots.size;
  }

  private ready(pending: PendingCall): ToolCallPart | undefined {
    if (pending.emitted || !pending.name) return undefined;
    const args = parseArgs(pending.args);
    if (!args) return undefined;
    pending.emitted = true;
    return { type: 'tool_call', id: pending.id, name: pending.name, args };
  }
}

/**
 * Arguments must be a JSON object, and anything not yet balanced is a prefix that
 * must keep accumulating.
 *
 * An empty buffer is *not* treated as `{}` here: OpenAI opens a tool call with
 * `"arguments": ""` and sends the real object in later frames, so resolving on empty
 * would emit every call with no arguments at all. Emptiness only means "no arguments"
 * once the provider has said the block is finished, which `close()` handles.
 */
function parseArgs(raw: string): Record<string, unknown> | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  if (!balanced(text)) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Cheap structural check that skips a `JSON.parse` throw on every single fragment. */
function balanced(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && !inString;
}
