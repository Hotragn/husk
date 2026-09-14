import { id } from '@husk/core';
import type { ToolCallPart } from '@husk/core';
import { notFound } from './errors.js';

export interface PendingApproval {
  approvalId: string;
  runId: string;
  husk: string;
  call: ToolCallPart;
  createdAt: string;
  expiresAt: string;
}

interface Waiter extends PendingApproval {
  resolve(approved: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Human-in-the-loop gate for `approvalMode: "ask"`.
 *
 * The default is deny. An operator who walks away from the terminal must not
 * silently authorise a `rm -rf` two minutes later, so an unanswered approval times
 * out into `false` -- API.md's 120 s -- rather than hanging the run forever.
 */
export class ApprovalRegistry {
  private readonly pending = new Map<string, Waiter>();
  private readonly timeoutMs: number;
  private readonly remembered = new Set<string>();

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ resolve: _r, timer: _t, ...rest }) => rest);
  }

  private rememberKey(husk: string, call: ToolCallPart): string {
    return `${husk}:${call.name}`;
  }

  /**
   * Raise an approval and block until it is answered, times out, or the run aborts.
   * `onRaised` is where the caller pushes `approval_required` down the SSE stream.
   */
  request(
    args: { runId: string; husk: string; call: ToolCallPart; signal?: AbortSignal },
    onRaised: (pending: PendingApproval) => void,
  ): Promise<boolean> {
    if (this.remembered.has(this.rememberKey(args.husk, args.call))) return Promise.resolve(true);

    const approvalId = id('apr');
    const createdAt = new Date();
    const record = {
      approvalId,
      runId: args.runId,
      husk: args.husk,
      call: args.call,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.timeoutMs).toISOString(),
    };

    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean) => {
        const waiter = this.pending.get(approvalId);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(approvalId);
        resolve(approved);
      };

      const timer = setTimeout(() => settle(false), this.timeoutMs);
      timer.unref?.();
      this.pending.set(approvalId, { ...record, resolve: settle, timer });

      args.signal?.addEventListener('abort', () => settle(false), { once: true });
      onRaised(record);
    });
  }

  answer(approvalId: string, approve: boolean, remember = false): PendingApproval {
    const waiter = this.pending.get(approvalId);
    if (!waiter) throw notFound('approval', approvalId);
    const snapshot: PendingApproval = {
      approvalId: waiter.approvalId,
      runId: waiter.runId,
      husk: waiter.husk,
      call: waiter.call,
      createdAt: waiter.createdAt,
      expiresAt: waiter.expiresAt,
    };
    if (remember && approve) this.remembered.add(this.rememberKey(waiter.husk, waiter.call));
    waiter.resolve(approve);
    return snapshot;
  }

  /** Deny everything outstanding. Called on shutdown so no run is left blocked. */
  denyAll(): number {
    const n = this.pending.size;
    for (const waiter of [...this.pending.values()]) waiter.resolve(false);
    return n;
  }
}
