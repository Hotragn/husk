/**
 * Token estimation and context fitting.
 *
 * The estimate is a character heuristic, not a tokeniser: shipping a 2 MB BPE table
 * to save a caller from a 15% error is the wrong trade for a budget guard. It is used
 * to decide what to drop and whether a call is affordable, never to bill anyone.
 *
 * The fitting rule that matters: a `tool_call` and the `tool_result` that answers it
 * must travel together. Splitting them is a 400 from Anthropic, OpenAI and Google
 * alike, and it is the failure mode every naive "drop the oldest message" loop hits.
 */

import { clampText, estimateTokens, type ContentPart, type ModelMessage, type ToolSchema } from '@husk/core';

/** Per-message framing the provider adds around content. Roughly right everywhere. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** A small image, once tiled. Large images cost several times this. */
const IMAGE_TOKENS_ESTIMATE = 1_200;

export function estimateParts(parts: string | ContentPart[]): number {
  if (typeof parts === 'string') return estimateTokens(parts);
  let total = 0;
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        total += estimateTokens(p.text);
        break;
      case 'thinking':
        total += estimateTokens(p.text);
        break;
      case 'tool_result':
        total += estimateTokens(p.content) + MESSAGE_OVERHEAD_TOKENS;
        break;
      case 'tool_call':
        total += estimateTokens(p.name) + estimateTokens(JSON.stringify(p.args)) + MESSAGE_OVERHEAD_TOKENS;
        break;
      case 'image':
        total += IMAGE_TOKENS_ESTIMATE;
        break;
    }
  }
  return total;
}

export function estimateMessage(m: ModelMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateParts(m.content);
}

export function estimateTools(tools: ToolSchema[] | undefined): number {
  if (!tools?.length) return 0;
  let total = 16;
  for (const t of tools) {
    total += estimateTokens(t.name) + estimateTokens(t.description) + estimateTokens(JSON.stringify(t.parameters));
  }
  return total;
}

/** What the prompt will cost before the model says anything. */
export function estimateMessages(messages: ModelMessage[], tools?: ToolSchema[], system?: string): number {
  let total = estimateTools(tools);
  if (system) total += estimateTokens(system) + MESSAGE_OVERHEAD_TOKENS;
  for (const m of messages) total += estimateMessage(m);
  return total;
}

function partsOf(m: ModelMessage): ContentPart[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
}

function toolCallIds(m: ModelMessage): string[] {
  return partsOf(m)
    .filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
    .map((p) => p.id);
}

function toolResultIds(m: ModelMessage): string[] {
  return partsOf(m)
    .filter((p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result')
    .map((p) => p.toolCallId);
}

/**
 * Any `tool_result` whose `tool_call` is not present earlier in the list.
 *
 * Exported because it is the invariant `fitContext` exists to protect, and an
 * invariant nobody can assert is a comment.
 */
export function orphanedToolResults(messages: ModelMessage[]): string[] {
  const seen = new Set<string>();
  const orphans: string[] = [];
  for (const m of messages) {
    for (const id of toolResultIds(m)) if (!seen.has(id)) orphans.push(id);
    for (const id of toolCallIds(m)) seen.add(id);
  }
  return orphans;
}

/** A tool call whose result never arrives is equally fatal on some providers. */
export function danglingToolCalls(messages: ModelMessage[]): string[] {
  const answered = new Set<string>();
  for (const m of messages) for (const id of toolResultIds(m)) answered.add(id);
  const dangling: string[] = [];
  for (const m of messages) for (const id of toolCallIds(m)) if (!answered.has(id)) dangling.push(id);
  return dangling;
}

interface Block {
  messages: ModelMessage[];
  tokens: number;
  hasUser: boolean;
}

/**
 * Group messages into atomic units. A message that carries `tool_result` parts (or
 * has the `tool` role) belongs to the block that issued the call, so the two can only
 * ever be dropped together.
 */
function toBlocks(messages: ModelMessage[]): Block[] {
  const blocks: Block[] = [];
  for (const m of messages) {
    const answers = m.role === 'tool' || toolResultIds(m).length > 0;
    const last = blocks[blocks.length - 1];
    if (answers && last) {
      last.messages.push(m);
      last.tokens += estimateMessage(m);
      continue;
    }
    blocks.push({ messages: [m], tokens: estimateMessage(m), hasUser: m.role === 'user' && !answers });
  }
  return blocks;
}

export interface FitOptions {
  /** Never drop the last N conversational blocks. */
  keepLastTurns?: number;
  /** Leave room for the reply. Subtracted from the budget before fitting. */
  reserveOutputTokens?: number;
  tools?: ToolSchema[];
  system?: string;
  /** Replace what was dropped with a one-line note. On by default. */
  summarise?: boolean;
}

export interface FitResult {
  messages: ModelMessage[];
  /** Estimated tokens of the returned prompt, including tools and system. */
  tokens: number;
  /** Messages removed, in original order. */
  dropped: ModelMessage[];
  /** True when content had to be truncated because dropping was not enough. */
  truncated: boolean;
}

/**
 * Fit a conversation into `budget` tokens.
 *
 * Always kept: every system message, the block containing the first user turn, and
 * the last `keepLastTurns` blocks. Everything between them is dropped oldest-first.
 * If that is still not enough, the largest surviving tool results are clamped, and
 * only then does the head get sacrificed — but never in a way that orphans a result.
 */
export function fitContext(messages: ModelMessage[], budget: number, opts: FitOptions = {}): FitResult {
  const keepLast = Math.max(1, opts.keepLastTurns ?? 6);
  const summarise = opts.summarise ?? true;
  const reserve = Math.max(0, opts.reserveOutputTokens ?? 0);
  const target = Math.max(256, budget - reserve);

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const overhead =
    estimateTools(opts.tools) +
    (opts.system ? estimateTokens(opts.system) + MESSAGE_OVERHEAD_TOKENS : 0) +
    system.reduce((n, m) => n + estimateMessage(m), 0);

  const blocks = toBlocks(rest);
  const firstUser = blocks.findIndex((b) => b.hasUser);
  const protectedHead = firstUser === -1 ? -1 : firstUser;
  const tailStart = Math.max(0, blocks.length - keepLast);

  const keep = blocks.map(() => true);
  const dropped: ModelMessage[] = [];
  let total = overhead + blocks.reduce((n, b) => n + b.tokens, 0);

  for (let i = 0; i < blocks.length && total > target; i++) {
    if (i === protectedHead || i >= tailStart) continue;
    keep[i] = false;
    total -= blocks[i]!.tokens;
    dropped.push(...blocks[i]!.messages);
  }

  let out: ModelMessage[] = [];
  let notePlaced = false;
  for (let i = 0; i < blocks.length; i++) {
    if (keep[i]) {
      out.push(...blocks[i]!.messages);
      continue;
    }
    if (summarise && !notePlaced) {
      notePlaced = true;
      out.push(elisionNote(dropped.length));
      total += estimateMessage(out[out.length - 1]!);
    }
  }
  out = [...system, ...out];

  let truncated = false;
  if (total > target) {
    const clamped = clampLargest(out, total - target);
    out = clamped.messages;
    total = clamped.tokens + overhead - overheadOf(system);
    truncated = clamped.truncated;
  }

  return { messages: out, tokens: total, dropped, truncated };
}

function overheadOf(system: ModelMessage[]): number {
  return system.reduce((n, m) => n + estimateMessage(m), 0);
}

function elisionNote(count: number): ModelMessage {
  return {
    role: 'user',
    content: `[husk elided ${count} earlier message${count === 1 ? '' : 's'} to fit the context window]`,
  };
}

/**
 * Last resort: shrink the biggest tool results in place. Tool output is the only
 * content in a conversation that is routinely enormous and routinely disposable in
 * the middle, and `clampText` keeps its head and tail.
 */
function clampLargest(
  messages: ModelMessage[],
  excessTokens: number,
): { messages: ModelMessage[]; tokens: number; truncated: boolean } {
  const order = messages
    .map((m, i) => ({ i, size: estimateMessage(m), role: m.role }))
    .filter((e) => e.role !== 'system')
    .sort((a, b) => b.size - a.size);

  const out = [...messages];
  let recovered = 0;
  let truncated = false;

  for (const entry of order) {
    if (recovered >= excessTokens) break;
    const m = out[entry.i]!;
    const parts = partsOf(m);
    const results = parts.filter((p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result');
    if (results.length === 0 && typeof m.content !== 'string') continue;

    const before = estimateMessage(m);
    // 3.6 characters per token is `estimateTokens`' own ratio, inverted.
    const targetBytes = Math.max(512, Math.floor((before - (excessTokens - recovered)) * 3.6));
    if (results.length > 0) {
      out[entry.i] = {
        ...m,
        content: parts.map((p) =>
          p.type === 'tool_result'
            ? { ...p, content: clampText(p.content, Math.max(512, Math.floor(targetBytes / results.length))).text }
            : p,
        ),
      };
    } else if (typeof m.content === 'string') {
      out[entry.i] = { ...m, content: clampText(m.content, targetBytes).text };
    } else {
      continue;
    }
    recovered += before - estimateMessage(out[entry.i]!);
    truncated = true;
  }

  return { messages: out, tokens: out.reduce((n, m) => n + estimateMessage(m), 0), truncated };
}
