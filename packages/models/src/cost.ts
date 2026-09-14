/**
 * Cost accounting.
 *
 * Anthropic reports `input_tokens` *excluding* anything served from or written to the
 * prompt cache, so the three buckets add rather than overlap. Providers that do not
 * do prompt caching simply report zero for the cache buckets and the arithmetic is
 * unchanged.
 */

import type { ModelInfo, Usage } from '@husk-ai/core';

const PER_MTOK = 1_000_000;

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
}

export function priceOf(info: Pick<ModelInfo, 'pricing' | 'free'> | undefined): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const p = info?.pricing;
  if (!p) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const input = p.inputPerMTok || 0;
  return {
    input,
    output: p.outputPerMTok || 0,
    cacheRead: p.cacheReadPerMTok ?? input * 0.1,
    // A cache write is only billed where the catalog says so. Most providers charge
    // nothing to populate a cache entry, so the absent case is free, not a fraction
    // of input: guessing high here would invent cost that never appears on a bill.
    cacheWrite: p.cacheWritePerMTok ?? 0,
  };
}

export function breakdown(info: ModelInfo | undefined, usage: Usage): CostBreakdown {
  const price = priceOf(info);
  const inputUsd = (usage.inputTokens || 0) * price.input;
  const outputUsd = (usage.outputTokens || 0) * price.output;
  const cacheReadUsd = (usage.cacheReadTokens || 0) * price.cacheRead;
  const cacheWriteUsd = (usage.cacheWriteTokens || 0) * price.cacheWrite;
  const scale = (n: number) => n / PER_MTOK;
  const total = scale(inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd);
  return {
    inputUsd: scale(inputUsd),
    outputUsd: scale(outputUsd),
    cacheReadUsd: scale(cacheReadUsd),
    cacheWriteUsd: scale(cacheWriteUsd),
    totalUsd: round(total),
  };
}

/** What this call actually cost, in USD. Zero for a local model. */
export function costOf(info: ModelInfo | undefined, usage: Usage): number {
  return breakdown(info, usage).totalUsd;
}

/**
 * The cheapest this call could possibly be: you pay for the prompt whatever happens,
 * and the model is free to answer with nothing. This is the number a budget guard
 * must compare against, because refusing on an optimistic estimate lets a call
 * through that then blows the budget.
 */
export function minimumCostUsd(info: ModelInfo | undefined, inputTokens: number): number {
  const price = priceOf(info);
  return round((inputTokens * price.input) / PER_MTOK);
}

/** The worst case: the prompt, plus the model filling its entire output allowance. */
export function maximumCostUsd(
  info: ModelInfo | undefined,
  inputTokens: number,
  maxOutputTokens?: number,
): number {
  const price = priceOf(info);
  const out = maxOutputTokens ?? info?.maxOutputTokens ?? 4_096;
  return round((inputTokens * price.input + out * price.output) / PER_MTOK);
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')}`;
  return `$${n.toFixed(4)}`;
}

/** Sub-cent precision matters here; six decimal places is a hundredth of a cent. */
function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
