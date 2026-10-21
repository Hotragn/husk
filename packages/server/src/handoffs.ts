import { id } from '@husk-ai/core';
import type { HandoffOutcome } from '@husk-ai/core';
import { notFound } from './errors.js';

export interface PendingHandoff {
  handoffId: string;
  runId: string;
  husk: string;
  reason: string;
  /** The machine a viewer may show and send input to. Absent: nothing to show. */
  computerId?: string;
  createdAt: string;
}

interface Waiter extends PendingHandoff {
  settle(outcome: HandoffOutcome): void;
}

/**
 * The run is waiting on a person, and only a person ends that wait.
 *
 * Nothing else resolves a handoff: there is no timer, and a dropped viewer
 * connection is not an answer. A tunnel that falls over while someone is
 * entering a 2FA code must leave the run paused, not hand the machine back to
 * the agent. The only exits are `done` from the person, or the run ending.
 */
/** Who is holding the computer, for a tool call made while a handoff is open. */
export function heldText(handoffId: string, reason: string): string {
  return (
    `The user has the computer right now (handoff ${handoffId}: ${reason}). Wait for them to tell you they are ` +
    `done, then call hand_off_done with handoff "${handoffId}". Do not use the computer until then.`
  );
}

export class HandoffRegistry {
  private readonly pending = new Map<string, Waiter>();

  list(): PendingHandoff[] {
    return [...this.pending.values()].map(({ settle: _s, ...rest }) => rest);
  }

  request(
    args: { runId: string; husk: string; reason: string; computerId?: string; signal: AbortSignal },
    onRaised: (pending: PendingHandoff) => void,
  ): Promise<HandoffOutcome> {
    if (args.signal.aborted) return Promise.resolve('aborted');

    const handoffId = id('hnd');
    const record: PendingHandoff = {
      handoffId,
      runId: args.runId,
      husk: args.husk,
      reason: args.reason,
      ...(args.computerId ? { computerId: args.computerId } : {}),
      createdAt: new Date().toISOString(),
    };

    return new Promise<HandoffOutcome>((resolve) => {
      const onAbort = (): void => settle('aborted');
      const settle = (outcome: HandoffOutcome): void => {
        if (!this.pending.delete(handoffId)) return;
        args.signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      this.pending.set(handoffId, { ...record, settle });
      args.signal.addEventListener('abort', onAbort, { once: true });
      onRaised(record);
    });
  }

  /** The open handoff, or a 404. A viewer's access lasts exactly as long as this does. */
  get(handoffId: string): PendingHandoff {
    const waiter = this.pending.get(handoffId);
    if (!waiter) throw notFound('handoff', handoffId);
    const { settle: _s, ...snapshot } = waiter;
    return snapshot;
  }

  /** Whether this handoff is still waiting. */
  isOpen(handoffId: string): boolean {
    return this.pending.has(handoffId);
  }

  /** A person says they are done. Resumes the run; the only path that does. */
  complete(handoffId: string): PendingHandoff {
    const snapshot = this.get(handoffId);
    this.pending.get(handoffId)?.settle('done');
    return snapshot;
  }

  /**
   * End one wait without a person's "done": the chat that asked has gone, so
   * nobody is left to hand the computer back to. The computer is free again.
   */
  cancel(handoffId: string): PendingHandoff {
    const snapshot = this.get(handoffId);
    this.pending.get(handoffId)?.settle('aborted');
    return snapshot;
  }

  /** End every wait. Called on shutdown so no run is left parked forever. */
  denyAll(): number {
    const waiters = [...this.pending.values()];
    for (const waiter of waiters) waiter.settle('aborted');
    return waiters.length;
  }
}
