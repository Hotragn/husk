/**
 * Requests per minute, counted on what a tunnel does not hide: the signed-in
 * app, the app registering, the claim code, and each route as a whole. Never
 * on the address, which behind a tunnel is loopback for everyone, so one
 * scanner would lock the owner out.
 * ponytail: fixed one-minute windows in memory, per process; a sliding window
 * if bursts at a window's edge ever matter.
 */
export class Limits {
  private readonly windows = new Map<string, { start: number; n: number }>();

  constructor(private readonly now: () => number) {}

  /** Count one request for `key`; false once it has had `max` this minute. */
  take(key: string, max: number): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (t - v.start >= 60_000) this.windows.delete(k);
      this.windows.set(key, { start: t, n: 1 });
      return true;
    }
    if (w.n >= max) return false;
    w.n++;
    return true;
  }
}

/** Per minute. Generous for one person's chats, small for a scanner. */
export const LIMITS = {
  /** Calls to /mcp by one signed-in app, and by everyone together. */
  app: 300,
  mcp: 1200,
  /** Registrations by everyone: apps register once. */
  register: 20,
  /** Sign-in steps and approvals, by everyone. */
  signIn: 60,
  /** Token requests by one app, and by everyone. */
  token: 30,
  tokens: 120,
};
