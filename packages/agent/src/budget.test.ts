import { describe, expect, it } from 'vitest';
import { Budget, pricingOf } from './budget.js';

const limits = { maxSteps: 5, maxCostUsd: 1, maxTokens: 1000, timeoutMs: 10_000 };

describe('Budget', () => {
  it('allows a call inside every ceiling', () => {
    const b = new Budget(limits);
    expect(b.check({ tokens: 10, costUsd: 0.01 })).toEqual({ ok: true });
  });

  it('stops on the step ceiling', () => {
    const b = new Budget({ ...limits, maxSteps: 2 });
    b.beginStep();
    b.beginStep();
    const d = b.check();
    expect(d.ok).toBe(false);
    expect(d.stopReason).toBe('step_limit');
  });

  it('refuses the call that would breach the cost ceiling, not the one after it', () => {
    const b = new Budget({ ...limits, maxCostUsd: 0.1 }, { pricing: { inputPerMTok: 1000, outputPerMTok: 1000 } });
    b.record({ inputTokens: 0, outputTokens: 0, costUsd: 0.09 });
    // 20k tokens at $1000/MTok is $0.02, which takes us to $0.11.
    const d = b.check(b.estimate(10_000, 10_000));
    expect(d.ok).toBe(false);
    expect(d.stopReason).toBe('budget');
    expect(b.costUsd).toBeCloseTo(0.09);
  });

  it('falls back to the worst observed call when there is no price table', () => {
    const b = new Budget({ ...limits, maxCostUsd: 0.5 });
    expect(b.estimate(1000, 1000).costUsd).toBe(0);
    b.record({ inputTokens: 1, outputTokens: 1, costUsd: 0.3 });
    expect(b.estimate(1000, 1000).costUsd).toBe(0.3);
    b.record({ inputTokens: 1, outputTokens: 1, costUsd: 0.1 });
    expect(b.check(b.estimate(1000, 1000)).stopReason).toBe('budget');
  });

  it('stops on the token ceiling before the call is made', () => {
    const b = new Budget({ ...limits, maxTokens: 100 });
    b.record({ inputTokens: 50, outputTokens: 20 });
    const d = b.check({ tokens: 40, costUsd: 0 });
    expect(d.stopReason).toBe('budget');
    expect(b.totalTokens).toBe(70);
  });

  it('stops on wall clock', () => {
    let now = 0;
    const b = new Budget({ ...limits, timeoutMs: 1000 }, { now: () => now });
    expect(b.check().ok).toBe(true);
    now = 1001;
    expect(b.check().stopReason).toBe('timeout');
    expect(b.remainingMs).toBe(0);
  });

  it('accumulates usage across calls', () => {
    const b = new Budget(limits);
    b.record({ inputTokens: 10, outputTokens: 5, costUsd: 0.01, cacheReadTokens: 3 });
    b.record({ inputTokens: 20, outputTokens: 1, costUsd: 0.02 });
    expect(b.snapshot()).toMatchObject({ inputTokens: 30, outputTokens: 6, cacheReadTokens: 3 });
    expect(b.costUsd).toBeCloseTo(0.03);
    expect(b.calls).toBe(2);
  });

  it('reads pricing off a ModelInfo, and ignores a free one', () => {
    expect(pricingOf({ pricing: { inputPerMTok: 3, outputPerMTok: 15 } } as never)).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
    expect(pricingOf({ pricing: { inputPerMTok: 0, outputPerMTok: 0 } } as never)).toBeUndefined();
    expect(pricingOf(null)).toBeUndefined();
  });
});
