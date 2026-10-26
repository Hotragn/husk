import { randomBytes } from 'node:crypto';

/**
 * The owner's word on a remote chat's tool call that changes things (shell,
 * file writes, clicks and typing in the browser). The call answers at once
 * with a link to a page under the public URL, where the owner approves with
 * their passkey from wherever they are; the model then calls again with the
 * same arguments. Nothing is approved for them: no answer within ten minutes
 * is a no, and an approval is spent by the one call it was for. The owner may
 * let one app use one tool for an hour, never by default.
 */

export interface ApprovalAsk {
  owner: string;
  client: string;
  /** The app's name, for the page. */
  app: string;
  tool: string;
  /** What the call would do, in a line the owner can judge, never a secret it carries. */
  summary: string;
  /** The call itself, hashed: a retry with other arguments is another call. */
  digest: string;
}

export interface Approval extends ApprovalAsk {
  id: string;
  state: 'pending' | 'approved' | 'denied';
  expiresAt: number;
  /** The passkey challenge outstanding on its page. */
  challenge?: string;
}

export type Verdict = { ok: true } | { ok: false; state: 'asked' | 'waiting' | 'denied'; link: string };

const TTL_MS = 10 * 60 * 1000;
const HOUR_MS = 3600 * 1000;
const MAX_PENDING = 100;

export class Approvals {
  private readonly byId = new Map<string, Approval>();
  /** `owner \n client \n tool` -> until when that app may use that tool unasked. */
  private readonly allowed = new Map<string, number>();

  constructor(
    private readonly origin: string,
    private readonly now: () => number,
  ) {}

  private key(a: { owner: string; client: string; tool: string }): string {
    return `${a.owner}\n${a.client}\n${a.tool}`;
  }

  /** Whether this call may run now; otherwise the page to send the owner to. */
  check(ask: ApprovalAsk): Verdict {
    const now = this.now();
    if ((this.allowed.get(this.key(ask)) ?? 0) > now) return { ok: true };
    for (const [id, a] of this.byId) if (now >= a.expiresAt) this.byId.delete(id);
    const same = [...this.byId.values()].find((a) => a.owner === ask.owner && a.client === ask.client && a.digest === ask.digest);
    if (same?.state === 'approved') {
      this.byId.delete(same.id);
      return { ok: true };
    }
    if (same?.state === 'denied') {
      this.byId.delete(same.id);
      return { ok: false, state: 'denied', link: '' };
    }
    if (same) return { ok: false, state: 'waiting', link: this.link(same.id) };
    if (this.byId.size >= MAX_PENDING) return { ok: false, state: 'waiting', link: '' };
    const id = randomBytes(16).toString('base64url');
    this.byId.set(id, { ...ask, id, state: 'pending', expiresAt: now + TTL_MS });
    return { ok: false, state: 'asked', link: this.link(id) };
  }

  private link(id: string): string {
    return `${this.origin}/oauth/approve?id=${id}`;
  }

  /** A pending approval still in date. */
  pending(id: unknown): Approval | undefined {
    const a = typeof id === 'string' ? this.byId.get(id) : undefined;
    return a && a.state === 'pending' && this.now() < a.expiresAt ? a : undefined;
  }

  /** The owner's answer, after their passkey. `hour`: that app may use that tool unasked for the next hour. */
  decide(a: Approval, allow: boolean, hour: boolean): void {
    a.state = allow ? 'approved' : 'denied';
    if (allow && hour) this.allowed.set(this.key(a), this.now() + HOUR_MS);
  }

  /** Remote access reset or switched off: nothing anyone approved holds any more. */
  clear(): void {
    this.byId.clear();
    this.allowed.clear();
  }
}
