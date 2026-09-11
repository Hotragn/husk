import { describe, expect, it } from 'vitest';
import { findModel } from './catalog.js';
import { breakdown, costOf, formatUsd, maximumCostUsd, minimumCostUsd, priceOf } from './cost.js';

const sonnet = findModel('anthropic/claude-sonnet-5')!;
const haiku = findModel('anthropic/claude-haiku-4-5-20251001')!;
const gemma = findModel('ollama/gemma3')!;
const gpt41 = findModel('openai/gpt-4.1')!;

describe('costOf', () => {
  it('prices a million in and a million out at the table rate', () => {
    const cost = costOf(sonnet, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(sonnet.pricing!.inputPerMTok + sonnet.pricing!.outputPerMTok, 8);
  });

  it('prices Haiku 4.5 at $1 in and $5 out per MTok', () => {
    expect(costOf(haiku, { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1, 8);
    expect(costOf(haiku, { inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(5, 8);
  });

  it('charges nothing for a local model', () => {
    expect(costOf(gemma, { inputTokens: 900_000, outputTokens: 900_000 })).toBe(0);
  });

  it('charges nothing when the model is unknown', () => {
    expect(costOf(undefined, { inputTokens: 5_000, outputTokens: 5_000 })).toBe(0);
  });

  it('bills a cache read at a tenth of the input rate', () => {
    const read = costOf(haiku, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(read).toBeCloseTo(0.1, 6);
  });

  it('bills an Anthropic cache write at the published 1.25x-input rate', () => {
    const write = costOf(haiku, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
    expect(write).toBeCloseTo(1.25, 6);
    expect(haiku.pricing!.cacheWritePerMTok).toBe(1.25);
  });

  it('charges nothing for a cache write where the provider does not bill one', () => {
    // GPT-4.1 prices a cache read but populating the cache is free, so a global
    // 1.25x-input assumption would bill $2.50 for a million tokens that cost nothing.
    expect(gpt41.pricing!.cacheWritePerMTok).toBeUndefined();
    const write = costOf(gpt41, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
    expect(write).toBe(0);
  });

  it('adds the four buckets rather than double counting the prompt', () => {
    const parts = breakdown(haiku, {
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 400_000,
      cacheWriteTokens: 200_000,
    });
    expect(parts.inputUsd).toBeCloseTo(0.1, 8);
    expect(parts.outputUsd).toBeCloseTo(0.05, 8);
    expect(parts.cacheReadUsd).toBeCloseTo(0.04, 8);
    expect(parts.cacheWriteUsd).toBeCloseTo(0.25, 8);
    expect(parts.totalUsd).toBeCloseTo(0.44, 8);
  });
});

describe('budget bounds', () => {
  it('the floor is the prompt alone — the model may answer with nothing', () => {
    expect(minimumCostUsd(sonnet, 200_000)).toBeCloseTo(0.6, 8);
  });

  it('the ceiling assumes the model fills its whole output allowance', () => {
    const ceiling = maximumCostUsd(haiku, 100_000, 8_000);
    expect(ceiling).toBeCloseTo(0.1 + (8_000 * 5) / 1_000_000, 8);
  });

  it('a free model has a floor of zero however long the prompt is', () => {
    expect(minimumCostUsd(gemma, 5_000_000)).toBe(0);
  });

  it('falls back to a tenth of the input rate when no cache price is published', () => {
    expect(priceOf({ pricing: { inputPerMTok: 2, outputPerMTok: 8 } }).cacheRead).toBeCloseTo(0.2, 8);
  });
});

describe('formatUsd', () => {
  it('shows sub-cent amounts without rounding them to zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.000123)).toBe('$0.000123');
    expect(formatUsd(1.5)).toBe('$1.5000');
  });
});
