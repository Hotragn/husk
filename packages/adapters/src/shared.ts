import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Split a reply to fit a platform's message limit.
 *
 * Splitting mid-token turns a code block into two broken code blocks, so the
 * boundary is chosen by preference: paragraph, then line, then sentence, then word,
 * and only a hard cut when a single word is longer than the whole limit. Fenced
 * blocks that span a boundary are re-opened, because a chat client that never sees
 * the closing fence renders the rest of the conversation as code.
 */
export function chunkMessage(text: string, limit: number): string[] {
  if (limit <= 0) throw new Error('chunk limit must be positive');
  if (text.length <= limit) return text.length ? [text] : [];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut =
      lastIndexBefore(window, '\n\n') ??
      lastIndexBefore(window, '\n') ??
      lastIndexBefore(window, '. ') ??
      lastIndexBefore(window, ' ') ??
      limit;
    const piece = rest.slice(0, cut).trimEnd();
    chunks.push(piece);
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length) chunks.push(rest);

  return balanceFences(chunks);
}

function lastIndexBefore(window: string, needle: string): number | undefined {
  // Refuse a boundary in the first quarter: it produces a stub followed by a wall.
  const i = window.lastIndexOf(needle);
  return i > window.length / 4 ? i + needle.length : undefined;
}

function balanceFences(chunks: string[]): string[] {
  // An odd number of fence lines means the last one opened a block that this chunk
  // never closes, so close it here and re-open it -- with its language tag -- next.
  let reopen: string | undefined;
  return chunks.map((chunk) => {
    const body = reopen ? `${reopen}\n${chunk}` : chunk;
    const fences = body.match(/^ {0,3}```.*$/gm) ?? [];
    if (fences.length % 2 === 1) {
      reopen = fences[fences.length - 1]!.trimStart();
      return `${body}\n\`\`\``;
    }
    reopen = undefined;
    return body;
  });
}

/**
 * Remember message ids we have already handled.
 *
 * Every gateway in this package can redeliver: Discord replays on RESUME, Slack
 * retries an unacknowledged envelope, Telegram resends an update whose offset was
 * never committed. Without this, a reconnect costs the user a duplicate agent run
 * and duplicate money.
 */
export class IdempotencyCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly max = 2000,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True the first time an id is seen, false on every redelivery. */
  claim(key: string): boolean {
    const at = this.now();
    const previous = this.seen.get(key);
    if (previous !== undefined && at - previous < this.ttlMs) return false;
    this.seen.set(key, at);
    if (this.seen.size > this.max) {
      const cutoff = at - this.ttlMs;
      for (const [k, t] of this.seen) {
        if (t < cutoff) this.seen.delete(k);
        if (this.seen.size <= this.max * 0.75) break;
      }
      while (this.seen.size > this.max) {
        const oldest = this.seen.keys().next().value;
        if (oldest === undefined) break;
        this.seen.delete(oldest);
      }
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Sliding-window limiter, per user. Cheap enough to run on every inbound message. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max = 5,
    private readonly perMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the caller is inside its budget. Records the hit when it is. */
  allow(key: string): boolean {
    const at = this.now();
    const window = (this.hits.get(key) ?? []).filter((t) => at - t < this.perMs);
    if (window.length >= this.max) {
      this.hits.set(key, window);
      return false;
    }
    window.push(at);
    this.hits.set(key, window);
    return true;
  }

  retryAfterMs(key: string): number {
    const window = this.hits.get(key) ?? [];
    const oldest = window[0];
    if (oldest === undefined) return 0;
    return Math.max(0, this.perMs - (this.now() - oldest));
  }
}

/**
 * Reconnect delay with full jitter.
 *
 * Without the jitter, every bot on a provider that just restarted reconnects in
 * lockstep and re-creates the outage it is recovering from.
 */
export class Backoff {
  private attempt = 0;

  constructor(
    private readonly baseMs = 1000,
    private readonly maxMs = 60_000,
    private readonly random: () => number = Math.random,
  ) {}

  next(): number {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    // A floor of half the base keeps a jitter draw near zero from producing a
    // reconnect storm against a provider that is still down.
    return Math.min(this.maxMs, Math.floor(this.random() * ceiling) + Math.floor(this.baseMs / 2));
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export function hmacHex(secret: string, payload: string | Buffer, algorithm = 'sha256'): string {
  return createHmac(algorithm, secret).update(payload).digest('hex');
}

export function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Strip a leading `<@id>` mention so the model does not see the bot's own handle. */
export function stripMention(text: string, ids: string[]): string {
  let out = text;
  for (const id of ids) {
    out = out.replace(new RegExp(`<@!?${escapeRegex(id)}>`, 'g'), '');
  }
  return out.trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A typing indicator that keeps itself alive.
 *
 * Every platform's indicator expires after a few seconds; an agent run takes far
 * longer than that. Re-poking it on an interval is the difference between "the bot
 * is thinking" and "the bot is broken".
 */
export function keepTyping(fn: () => Promise<void>, everyMs = 8000): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    void fn().catch(() => undefined);
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
