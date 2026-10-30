import { randomBytes } from 'node:crypto';

/**
 * Short-lived tokens that each open one thing: a computer (`computer:<id>`), or
 * a handoff that has no computer (`handoff:<id>`). Never the server token.
 *
 * A token dies after `idleMs` without use -- a link nobody opened is worth
 * nothing ten minutes later -- and is kept alive while a viewer is using it,
 * up to `maxMs`, so a long login is not cut off halfway.
 *
 * Only a token minted `public` (for a remote chat's person) opens anything
 * under remote access's public URL: a link made on this machine stays on it.
 * `holder` is the remote app it was given to, so signing that app out ends it.
 */
export class ScopedTokens {
  private readonly tokens = new Map<string, { scope: string; idleUntil: number; deadline: number; public: boolean; holder?: string }>();

  constructor(
    private readonly idleMs = 10 * 60 * 1000,
    private readonly maxMs = 8 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  mint(scope: string, opts: { public?: boolean; holder?: string } = {}): string {
    this.sweep();
    const token = randomBytes(32).toString('hex');
    const t = this.now();
    this.tokens.set(token, {
      scope,
      idleUntil: t + this.idleMs,
      deadline: t + this.maxMs,
      public: opts.public === true,
      ...(opts.holder ? { holder: opts.holder } : {}),
    });
    return token;
  }

  /** Remote access off or reset (every public token), or one app signed out (the ones it holds). */
  revokePublic(holder?: string): void {
    for (const [token, entry] of this.tokens) if (entry.public && (holder === undefined || entry.holder === holder)) this.tokens.delete(token);
  }

  /**
   * The scope this token opens, or undefined. Each successful use extends it.
   * A map lookup is fine here: tokens are 256 random bits, so timing a lookup
   * tells a guesser nothing that would narrow the search.
   */
  verify(token: string, opts: { public?: boolean } = {}): string | undefined {
    const entry = this.tokens.get(token);
    if (!entry || (opts.public && !entry.public)) return undefined;
    const t = this.now();
    if (t > entry.idleUntil || t > entry.deadline) {
      this.tokens.delete(token);
      return undefined;
    }
    entry.idleUntil = Math.min(t + this.idleMs, entry.deadline);
    return entry.scope;
  }

  /**
   * End every token for a scope, e.g. when its handoff ends. A computer deleted
   * elsewhere is not revoked here; its tokens open nothing once it is gone,
   * and they idle out.
   */
  revoke(scope: string): void {
    for (const [token, entry] of this.tokens) if (entry.scope === scope) this.tokens.delete(token);
  }

  private sweep(): void {
    const t = this.now();
    for (const [token, entry] of this.tokens) if (t > entry.idleUntil || t > entry.deadline) this.tokens.delete(token);
  }
}
