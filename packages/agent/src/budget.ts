import type { ModelInfo, Usage } from '@husk/core';

export type BudgetStop = 'step_limit' | 'budget' | 'timeout';

export interface BudgetLimits {
  maxSteps: number;
  maxCostUsd: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface BudgetDecision {
  ok: boolean;
  stopReason?: BudgetStop;
  /** One line, suitable for a `warning` event or the run's error message. */
  reason?: string;
}

export interface CallEstimate {
  /** Tokens the request is about to consume, prompt plus expected completion. */
  tokens: number;
  costUsd: number;
}

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export function pricingOf(info: ModelInfo | null | undefined): Pricing | undefined {
  if (!info?.pricing) return undefined;
  const { inputPerMTok, outputPerMTok } = info.pricing;
  if (!inputPerMTok && !outputPerMTok) return undefined;
  return { inputPerMTok, outputPerMTok };
}

/**
 * Steps, dollars, tokens and wall clock for one run.
 *
 * `check()` runs BEFORE each model call with an estimate of what that call will
 * cost, so a ceiling is never breached -- only approached. Checking afterwards,
 * as the first draft of the loop did, detects an overspend one whole call too late.
 */
export class Budget {
  readonly limits: BudgetLimits;
  readonly startedAt: number;
  private readonly now: () => number;

  steps = 0;
  calls = 0;
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  /** Worst call seen so far, used to estimate the next one when pricing is unknown. */
  private worstCallCostUsd = 0;
  private pricing: Pricing | undefined;

  constructor(limits: BudgetLimits, opts: { now?: () => number; pricing?: Pricing } = {}) {
    this.limits = limits;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.pricing = opts.pricing;
  }

  setPricing(p: Pricing | undefined): void {
    this.pricing = p;
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.limits.timeoutMs - this.elapsedMs);
  }

  get totalTokens(): number {
    return this.usage.inputTokens + this.usage.outputTokens;
  }

  get costUsd(): number {
    return this.usage.costUsd ?? 0;
  }

  /**
   * Price a call we have not made yet.
   *
   * With a price table this is arithmetic. Without one -- a local model, or a
   * router that cannot introspect -- we fall back to the most expensive call
   * observed so far, which is zero on the first call and honest after that.
   */
  estimate(promptTokens: number, expectedOutputTokens: number): CallEstimate {
    const tokens = promptTokens + expectedOutputTokens;
    if (this.pricing) {
      const costUsd =
        (promptTokens * this.pricing.inputPerMTok + expectedOutputTokens * this.pricing.outputPerMTok) / 1_000_000;
      return { tokens, costUsd };
    }
    return { tokens, costUsd: this.worstCallCostUsd };
  }

  /** Decide whether one more model call is affordable. Call this before every call. */
  check(estimate: CallEstimate = { tokens: 0, costUsd: 0 }): BudgetDecision {
    if (this.steps >= this.limits.maxSteps) {
      return { ok: false, stopReason: 'step_limit', reason: `reached the step ceiling of ${this.limits.maxSteps}` };
    }
    if (this.elapsedMs >= this.limits.timeoutMs) {
      return {
        ok: false,
        stopReason: 'timeout',
        reason: `ran out of time after ${Math.round(this.elapsedMs / 1000)}s`,
      };
    }
    const projectedCost = this.costUsd + estimate.costUsd;
    if (projectedCost > this.limits.maxCostUsd) {
      return {
        ok: false,
        stopReason: 'budget',
        reason: `the next call would cost about $${projectedCost.toFixed(4)}, over the $${this.limits.maxCostUsd} ceiling`,
      };
    }
    const projectedTokens = this.totalTokens + estimate.tokens;
    if (projectedTokens > this.limits.maxTokens) {
      return {
        ok: false,
        stopReason: 'budget',
        reason: `the next call would reach about ${projectedTokens} tokens, over the ${this.limits.maxTokens} ceiling`,
      };
    }
    return { ok: true };
  }

  beginStep(): number {
    this.steps += 1;
    return this.steps;
  }

  record(u: Usage): void {
    this.calls += 1;
    this.usage.inputTokens += u.inputTokens || 0;
    this.usage.outputTokens += u.outputTokens || 0;
    if (u.cacheReadTokens) this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + u.cacheReadTokens;
    if (u.cacheWriteTokens) this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens ?? 0) + u.cacheWriteTokens;
    const cost = u.costUsd ?? 0;
    this.usage.costUsd = (this.usage.costUsd ?? 0) + cost;
    if (cost > this.worstCallCostUsd) this.worstCallCostUsd = cost;
  }

  snapshot(): Usage {
    return { ...this.usage };
  }
}
