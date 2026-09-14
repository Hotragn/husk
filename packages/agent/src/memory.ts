import { messageText } from '@husk/core';
import type { ContentPart, ModelMessage } from '@husk/core';

/**
 * Conversation trimming.
 *
 * The one rule that matters: never separate a `tool_call` from its `tool_result`.
 * Every provider answers a dangling pair with a 400, and it is the failure mode
 * every naive "keep the last N messages" implementation walks straight into.
 */

export interface TrimOptions {
  /** Turns of raw history kept verbatim at the tail. */
  windowTurns: number;
  /** Ask the summariser for a précis of the middle. Falls back to a marker. */
  summarise?: boolean;
  summariser?: (messages: ModelMessage[]) => Promise<string | null>;
  onWarning?: (message: string) => void;
}

export interface TrimResult {
  messages: ModelMessage[];
  /** How many messages were removed from the middle. */
  elided: number;
  summarised: boolean;
}

function parts(m: ModelMessage): ContentPart[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
}

/** A real user turn, as opposed to a user message carrying tool results. */
function isTurnStart(m: ModelMessage): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return !m.content.every((p) => p.type === 'tool_result');
}

/** Split into turns: each turn opens at a user message and owns everything after it. */
function toTurns(messages: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  let current: ModelMessage[] = [];
  for (const m of messages) {
    if (isTurnStart(m) && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length) turns.push(current);
  return turns;
}

/**
 * Drop tool results with no preceding call and tool calls with no following result.
 *
 * Defensive: the turn-boundary cut above should never produce either. This pass
 * makes the invariant true no matter what the caller handed us.
 */
export function pruneOrphans(messages: ModelMessage[]): ModelMessage[] {
  const resultIds = new Set<string>();
  for (const m of messages) {
    for (const p of parts(m)) if (p.type === 'tool_result') resultIds.add(p.toolCallId);
  }

  const out: ModelMessage[] = [];
  const seenCallIds = new Set<string>();

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m);
      continue;
    }
    const kept: ContentPart[] = [];
    for (const p of m.content) {
      if (p.type === 'tool_call') {
        if (!resultIds.has(p.id)) continue;
        seenCallIds.add(p.id);
        kept.push(p);
        continue;
      }
      if (p.type === 'tool_result') {
        if (!seenCallIds.has(p.toolCallId)) continue;
        kept.push(p);
        continue;
      }
      kept.push(p);
    }
    if (!kept.length) continue;
    // An assistant turn reduced to nothing but whitespace helps no one.
    if (kept.every((p) => p.type === 'text' && !p.text.trim())) continue;
    out.push({ ...m, content: kept });
  }

  return out;
}

export async function trimHistory(messages: ModelMessage[], opts: TrimOptions): Promise<TrimResult> {
  const windowTurns = Math.max(1, opts.windowTurns);

  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd]!.role === 'system') headEnd += 1;
  const head = messages.slice(0, headEnd);
  const body = messages.slice(headEnd);

  const turns = toTurns(body);
  const firstUserIdx = turns.findIndex((t) => t[0] !== undefined && isTurnStart(t[0]));

  // Everything before the first real user turn is preamble we keep as-is.
  const anchorEnd = firstUserIdx === -1 ? turns.length : firstUserIdx + 1;
  const tailStart = Math.max(anchorEnd, turns.length - windowTurns);
  if (tailStart <= anchorEnd) {
    return { messages, elided: 0, summarised: false };
  }

  const preamble = turns.slice(0, Math.max(0, anchorEnd - 1)).flat();
  const firstTurn = firstUserIdx === -1 ? [] : turns[firstUserIdx]!;
  // Only the user's opening message survives from the first turn: it is the
  // anchor that tells the model what it was asked to do, and keeping just it
  // cannot orphan a tool result.
  const anchor = firstTurn.length ? [firstTurn[0]!] : [];

  const middle = turns.slice(anchorEnd, tailStart).flat();
  const tail = turns.slice(tailStart).flat();

  let summary: string | null = null;
  if (opts.summarise && opts.summariser && middle.length) {
    try {
      summary = await opts.summariser(middle);
    } catch (err) {
      opts.onWarning?.(`could not summarise trimmed history: ${(err as Error).message}`);
    }
  }

  const marker: ModelMessage = {
    role: 'assistant',
    content: summary
      ? `[husk: ${middle.length} earlier messages summarised]\n${summary}`
      : `[husk: ${middle.length} earlier messages elided to stay inside the context window]`,
  };

  const out = pruneOrphans([...head, ...preamble, ...anchor, marker, ...tail]);
  return { messages: out, elided: middle.length, summarised: Boolean(summary) };
}

/** Flatten a slice of conversation into something a cheap model can summarise. */
export function renderForSummary(messages: ModelMessage[], maxChars = 12_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = messageText(m).trim();
    const calls = parts(m)
      .filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
      .map((p) => `${p.name}(${JSON.stringify(p.args).slice(0, 200)})`);
    const body = [text, calls.length ? `called: ${calls.join(', ')}` : ''].filter(Boolean).join('\n');
    if (body) lines.push(`${m.role}: ${body}`);
  }
  const joined = lines.join('\n\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) + '\n...' : joined;
}
