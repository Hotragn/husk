import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived tokens that each open one thing: a computer (`computer:<id>`), or
 * a handoff that has no computer (`handoff:<id>`). Never the server token.
 *
 * A token dies after `idleMs` without use -- a link nobody opened is worth
 * nothing ten minutes later -- and is kept alive while a viewer is using it,
 * up to `maxMs`, so a long login is not cut off halfway.
 */
export class ScopedTokens {
  private readonly tokens = new Map<string, { scope: string; idleUntil: number; deadline: number }>();

  constructor(
    private readonly idleMs = 10 * 60 * 1000,
    private readonly maxMs = 8 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  mint(scope: string): string {
    this.sweep();
    const token = randomBytes(32).toString('hex');
    const t = this.now();
    this.tokens.set(token, { scope, idleUntil: t + this.idleMs, deadline: t + this.maxMs });
    return token;
  }

  /** The scope this token opens, or undefined. Each successful use extends it. */
  verify(token: string): string | undefined {
    if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
    // Compare against every live token in constant time per entry, so a guess
    // learns nothing from timing about how close it came.
    const supplied = Buffer.from(token);
    let match: string | undefined;
    for (const key of this.tokens.keys()) {
      if (timingSafeEqual(Buffer.from(key), supplied)) match = key;
    }
    if (!match) return undefined;
    const entry = this.tokens.get(match)!;
    const t = this.now();
    if (t > entry.idleUntil || t > entry.deadline) {
      this.tokens.delete(match);
      return undefined;
    }
    entry.idleUntil = Math.min(t + this.idleMs, entry.deadline);
    return entry.scope;
  }

  /** End every token for a scope, e.g. when its handoff ends or its computer is deleted. */
  revoke(scope: string): void {
    for (const [token, entry] of this.tokens) if (entry.scope === scope) this.tokens.delete(token);
  }

  private sweep(): void {
    const t = this.now();
    for (const [token, entry] of this.tokens) if (t > entry.idleUntil || t > entry.deadline) this.tokens.delete(token);
  }
}
