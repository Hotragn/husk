import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Backoff, IdempotencyCache, RateLimiter, chunkMessage, keepTyping, stripMention } from './shared.js';

describe('chunkMessage', () => {
  it('leaves a short message alone', () => {
    expect(chunkMessage('hello', 100)).toEqual(['hello']);
  });

  it('drops an empty message', () => {
    expect(chunkMessage('', 100)).toEqual([]);
  });

  it('never exceeds the limit', () => {
    const text = 'word '.repeat(2000);
    for (const chunk of chunkMessage(text, 200)) expect(chunk.length).toBeLessThanOrEqual(200);
  });

  it('prefers a paragraph boundary', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`;
    const chunks = chunkMessage(text, 80);
    expect(chunks[0]).toBe('a'.repeat(60));
    expect(chunks[1]).toBe('b'.repeat(60));
  });

  it('falls back to a line boundary', () => {
    const text = `${'a'.repeat(60)}\n${'b'.repeat(60)}`;
    expect(chunkMessage(text, 80)[0]).toBe('a'.repeat(60));
  });

  it('falls back to a word boundary rather than splitting a word', () => {
    const chunks = chunkMessage(`${'alpha '.repeat(20)}omega`, 50);
    for (const chunk of chunks) expect(chunk).not.toMatch(/alph$|alp$|al$/);
  });

  it('hard-cuts a single token longer than the whole limit', () => {
    const chunks = chunkMessage('x'.repeat(250), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe('x'.repeat(250));
  });

  it('loses no content across a split', () => {
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const rejoined = chunkMessage(text, 120).join('\n');
    for (let i = 0; i < 80; i++) expect(rejoined).toContain(`line ${i}`);
  });

  /**
   * The failure people actually notice: a code fence that opens in one message and
   * closes in the next renders the whole rest of the channel as code.
   */
  it('closes and re-opens a fenced block that spans a split', () => {
    const code = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const chunks = chunkMessage('Here:\n\n```ts\n' + code + '\n```', 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.match(/^ {0,3}```.*$/gm) ?? [];
      expect(fences.length % 2).toBe(0);
    }
    expect(chunks[1]!.startsWith('```ts')).toBe(true);
  });

  it('rejects a non-positive limit', () => {
    expect(() => chunkMessage('x', 0)).toThrow(/positive/);
  });
});

describe('IdempotencyCache', () => {
  it('claims an id once', () => {
    const cache = new IdempotencyCache();
    expect(cache.claim('m1')).toBe(true);
    expect(cache.claim('m1')).toBe(false);
    expect(cache.claim('m2')).toBe(true);
  });

  it('lets an id through again after the ttl', () => {
    let now = 0;
    const cache = new IdempotencyCache(100, 1000, () => now);
    expect(cache.claim('m1')).toBe(true);
    now = 999;
    expect(cache.claim('m1')).toBe(false);
    now = 1001;
    expect(cache.claim('m1')).toBe(true);
  });

  it('stays bounded under a flood', () => {
    const cache = new IdempotencyCache(50, 60_000);
    for (let i = 0; i < 500; i++) cache.claim(`m${i}`);
    expect(cache.size).toBeLessThanOrEqual(50);
  });

  it('still de-duplicates the most recent ids after eviction', () => {
    const cache = new IdempotencyCache(50, 60_000);
    for (let i = 0; i < 200; i++) cache.claim(`m${i}`);
    expect(cache.claim('m199')).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('allows up to the ceiling then refuses', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 60_000, () => now);
    expect([limiter.allow('u'), limiter.allow('u'), limiter.allow('u')]).toEqual([true, true, true]);
    expect(limiter.allow('u')).toBe(false);
  });

  it('is per key', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 60_000, () => now);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
  });

  it('slides rather than resetting on a fixed boundary', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    limiter.allow('u');
    now = 500;
    limiter.allow('u');
    now = 900;
    expect(limiter.allow('u')).toBe(false);
    now = 1001;
    // The first hit has aged out; the one at 500 has not.
    expect(limiter.allow('u')).toBe(true);
    expect(limiter.allow('u')).toBe(false);
  });

  it('reports how long to wait', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1000, () => now);
    limiter.allow('u');
    now = 400;
    expect(limiter.retryAfterMs('u')).toBe(600);
    expect(limiter.retryAfterMs('never-seen')).toBe(0);
  });
});

describe('Backoff', () => {
  it('grows the ceiling exponentially', () => {
    const backoff = new Backoff(1000, 60_000, () => 1);
    const delays = [backoff.next(), backoff.next(), backoff.next(), backoff.next()];
    expect(delays).toEqual([1500, 2500, 4500, 8500]);
  });

  it('caps at the maximum', () => {
    const backoff = new Backoff(1000, 5000, () => 1);
    for (let i = 0; i < 20; i++) backoff.next();
    expect(backoff.next()).toBe(5000);
  });

  /** Without jitter every bot reconnects on the same millisecond. */
  it('jitters, and never returns zero', () => {
    const backoff = new Backoff(1000, 60_000, () => 0);
    expect(backoff.next()).toBe(500);

    const draws = new Set<number>();
    const jittered = new Backoff(1000, 60_000, Math.random);
    for (let i = 0; i < 8; i++) draws.add(jittered.next());
    expect(draws.size).toBeGreaterThan(1);
  });

  it('resets after a successful connection', () => {
    const backoff = new Backoff(1000, 60_000, () => 1);
    backoff.next();
    backoff.next();
    expect(backoff.attempts).toBe(2);
    backoff.reset();
    expect(backoff.attempts).toBe(0);
    expect(backoff.next()).toBe(1500);
  });
});

describe('stripMention', () => {
  it('removes the bot handle in both forms', () => {
    expect(stripMention('<@123> hello there', ['123'])).toBe('hello there');
    expect(stripMention('<@!123> hello', ['123'])).toBe('hello');
  });

  it('leaves other mentions alone', () => {
    expect(stripMention('<@123> ping <@456>', ['123'])).toBe('ping <@456>');
  });

  it('is a no-op with no ids', () => {
    expect(stripMention('<@123> hello', [])).toBe('<@123> hello');
  });
});

/**
 * Fake timers, because the real ones lie under load.
 *
 * This used to poke on a 5ms interval, sleep 26ms of wall clock and assert
 * "more than 2 calls". On an idle machine that is 5 calls; in a full parallel
 * test run the event loop starves and it is 1 or 2, so the suite failed for
 * reasons that had nothing to do with `keepTyping`. A controlled clock also
 * lets the assertions be exact rather than `toBeGreaterThan`.
 */
describe('keepTyping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pokes immediately and then on an interval, and stops on demand', async () => {
    let calls = 0;
    const stop = keepTyping(async () => {
      calls++;
    }, 5);

    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(5);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(15);
    expect(calls).toBe(5);

    stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(5);
  });

  it('swallows a failing poke rather than crashing the adapter', async () => {
    let pokes = 0;
    const stop = keepTyping(async () => {
      pokes++;
      throw new Error('typing api down');
    }, 5);

    // The point is that it keeps going: a typing indicator is decoration, and
    // losing it must never take the reply down with it.
    await vi.advanceTimersByTimeAsync(15);
    expect(pokes).toBeGreaterThan(1);
    stop();
  });
});
