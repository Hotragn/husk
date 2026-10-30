import { describe, expect, it } from 'vitest';
import { ScopedTokens } from './scoped-tokens.js';

describe('scoped tokens', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('opens exactly the scope it was minted for', () => {
    const tokens = new ScopedTokens();
    const a = tokens.mint('computer:cmp_a');
    const b = tokens.mint('computer:cmp_b');
    expect(tokens.verify(a)).toBe('computer:cmp_a');
    expect(tokens.verify(b)).toBe('computer:cmp_b');
    expect(a).not.toBe(b);
  });

  it('refuses a malformed or unknown token', () => {
    const tokens = new ScopedTokens();
    tokens.mint('computer:cmp_a');
    expect(tokens.verify('')).toBeUndefined();
    expect(tokens.verify('not-a-token')).toBeUndefined();
    expect(tokens.verify('f'.repeat(64))).toBeUndefined();
  });

  it('dies after the idle window if nobody uses it', () => {
    const c = clock();
    const tokens = new ScopedTokens(1000, 10_000, c.now);
    const t = tokens.mint('computer:cmp_a');
    c.advance(1001);
    expect(tokens.verify(t)).toBeUndefined();
  });

  it('stays alive while used, but never past its hard limit', () => {
    const c = clock();
    const tokens = new ScopedTokens(1000, 3000, c.now);
    const t = tokens.mint('computer:cmp_a');
    for (let i = 0; i < 2; i++) {
      c.advance(900);
      expect(tokens.verify(t)).toBe('computer:cmp_a');
    }
    c.advance(900); // 2700ms: still inside both windows
    expect(tokens.verify(t)).toBe('computer:cmp_a');
    c.advance(400); // 3100ms: past the hard limit, though used recently
    expect(tokens.verify(t)).toBeUndefined();
  });

  it('can be revoked by scope', () => {
    const tokens = new ScopedTokens();
    const t = tokens.mint('handoff:hnd_1');
    const other = tokens.mint('computer:cmp_a');
    tokens.revoke('handoff:hnd_1');
    expect(tokens.verify(t)).toBeUndefined();
    expect(tokens.verify(other)).toBe('computer:cmp_a');
  });
});
