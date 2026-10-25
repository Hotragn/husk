import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { livePageFor } from '@husk-ai/browser';
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
  /** A person's take-over: where they took it. A link's take-over is that link's to give back too. */
  takenFrom?: 'console' | 'link';
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

/** The `runId` of a handoff the person started from the console, rather than one a chat asked for. */
export const PERSON_RUN = 'person';

/** The `runId` of a handoff a chat asked the shared Husk for. */
export const CHAT_RUN = 'chat';

/** How often an open hold touches its computer's browser: well inside the browser's five idle minutes. */
export const KEEP_ALIVE_MS = 60_000;

/** Why every computer is held after a restart that could not read who held which. */
export const UNREADABLE_HOLDS =
  'Husk restarted and could not read who held this computer, so it is held for you. Give it back when the AI may use it again.';

function isHold(v: unknown): v is PendingHandoff {
  const h = v as Partial<PendingHandoff> | null;
  return (
    typeof h?.handoffId === 'string' &&
    (h.runId === PERSON_RUN || h.runId === CHAT_RUN) &&
    typeof h.husk === 'string' &&
    typeof h.reason === 'string' &&
    typeof h.createdAt === 'string' &&
    (h.computerId === undefined || typeof h.computerId === 'string') &&
    (h.takenFrom === undefined || h.takenFrom === 'console' || h.takenFrom === 'link')
  );
}

/**
 * For a chat whose computer the person took, from the console or a link. It did
 * not ask, so it has no done to call. A link may have expired, and with no
 * shared Husk there is no console: computer_open_ui is the way back either way.
 */
export function takenText(handoffId: string): string {
  return (
    `The user took over this computer (handoff ${handoffId}). Stop using it: tell the user you are paused until ` +
    'they press Give back where they took it. If they need to get back to it, call computer_open_ui and give them ' +
    'the fresh link. Then try again. Do not call hand_off_done for this handoff.'
  );
}

/** A tab as the AI's calls left it, when a person took the computer. */
export interface PageMark {
  tab: string;
  url: string;
  title: string;
}

/** Browser tools that act on the page in front of them, by its refs or its state. */
const ACTS_ON_PAGE = new Set([
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_hover',
  'browser_scroll',
  'browser_upload',
  'browser_run',
  'browser_script',
  'browser_navigate',
]);
/** Browser tools that show the AI the page as it is now, so it can act on it again. */
const LOOKS_AGAIN = new Set(['browser_snapshot', 'browser_goto']);

/** For a chat whose browser call a take-over stopped part-way. */
const STOPPED_PART_WAY =
  'Your last browser call was stopped part-way when the user took over this computer, so the page may not be ' +
  'where it left it. This call was not run: take a browser_snapshot to see the page as it is now, then carry on.';

function pageChange(was: PageMark, now: PageMark): string | undefined {
  if (was.tab === now.tab && was.url === now.url && was.title === now.title) return undefined;
  const at = (p: PageMark) => (p.title ? `"${p.title}" at ${p.url}` : p.url);
  return (
    `The user changed the page while they had the computer: it is now ${at(now)}${was.tab === now.tab ? '' : ', in another tab'} ` +
    `(it was ${at(was)}). This call was not run: take a browser_snapshot to see the page as it is now, then carry on.`
  );
}

/** For a chat call a person's take-over stopped part-way, with what it printed by then. */
export function stoppedText(handoffId?: string, printed?: string): string {
  const now = handoffId ? takenText(handoffId) : 'They have given it back: check where things stand before you carry on.';
  return `The user took over this computer while this call was running, so it was stopped part-way. ${now}${printed ? `\n\nWhat it printed before it stopped:\n${printed}` : ''}`;
}

interface RunningCall {
  tool: string;
  /** When it started, for the console's "waiting for" and the desktop's open-on-start. */
  since: string;
  stop: AbortController;
  ended: Promise<void>;
}

/**
 * The AI's calls running on each computer, so a person taking one over stops
 * them instead of working alongside them; and the page as the AI left it, so
 * after Give back an action meant for that page does not land on another.
 */
export class ComputerControl {
  private readonly running = new Map<string, Set<RunningCall>>();
  /** The page when a person took the computer, until the AI's next browser call compares it. */
  private readonly marks = new Map<string, PageMark>();
  /** Why the AI's page actions are refused, until it looks at the page again. */
  private readonly stale = new Map<string, string>();

  /**
   * One AI call starting on a computer. Its signal aborts on `signal` or on a
   * take-over, and `takenOver()` says which; `done()` once the call has ended.
   */
  start(computerId: string, tool: string, signal?: AbortSignal): { signal: AbortSignal; takenOver(): boolean; done(): void } {
    const stop = new AbortController();
    let ended!: () => void;
    const call: RunningCall = { tool, since: new Date().toISOString(), stop, ended: new Promise<void>((r) => (ended = r)) };
    let calls = this.running.get(computerId);
    if (!calls) this.running.set(computerId, (calls = new Set()));
    calls.add(call);
    const mine = calls;
    return {
      signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
      takenOver: () => stop.signal.aborted,
      done: () => {
        mine.delete(call);
        if (!mine.size && this.running.get(computerId) === mine) this.running.delete(computerId);
        ended();
      },
    };
  }

  /** Whether the AI has a call running on this computer. */
  busy(computerId: string): boolean {
    return this.running.has(computerId);
  }

  /** The AI's call on each computer, the longest-running one: what a take-over waits for. */
  inFlight(): Record<string, { tool: string; since: string }> {
    const out: Record<string, { tool: string; since: string }> = {};
    for (const [id, calls] of this.running) {
      // A Set keeps insertion order: the first is the oldest.
      const first = calls.values().next().value;
      if (first) out[id] = { tool: first.tool, since: first.since };
    }
    return out;
  }

  /** A person took the computer: stop every AI call on it, and wait up to `waitMs` for them to end. The tools stopped. */
  async stop(computerId: string, waitMs = 15_000): Promise<string[]> {
    const calls = [...(this.running.get(computerId) ?? [])];
    if (!calls.length) return [];
    for (const c of calls) c.stop.abort(new Error('the person took over this computer'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(calls.map((c) => c.ended)), new Promise((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
    return calls.map((c) => c.tool);
  }

  /**
   * The page as the AI's calls left it, read once they stopped. A mark not yet
   * compared is kept: it is still what the AI last saw.
   */
  mark(computerId: string, page: PageMark | undefined, stoppedBrowserCall: boolean): void {
    if (stoppedBrowserCall && !this.stale.has(computerId)) this.stale.set(computerId, STOPPED_PART_WAY);
    if (page && !this.marks.has(computerId)) this.marks.set(computerId, page);
  }

  /**
   * Why this call must not run, if it acts on a page the person changed while
   * they had the computer. The first browser call after Give back compares
   * the page with the mark; a snapshot or a goto, which show the AI the page
   * as it is, clear the refusal.
   */
  async refusal(computerId: string, tool: string, now: () => Promise<PageMark | undefined>): Promise<string | undefined> {
    if (!tool.startsWith('browser_')) return undefined;
    const was = this.marks.get(computerId);
    if (was) {
      this.marks.delete(computerId);
      const page = await now();
      const change = page && pageChange(was, page);
      if (change && !this.stale.has(computerId)) this.stale.set(computerId, change);
    }
    if (LOOKS_AGAIN.has(tool)) {
      this.stale.delete(computerId);
      return undefined;
    }
    return ACTS_ON_PAGE.has(tool) ? this.stale.get(computerId) : undefined;
  }
}

export class HandoffRegistry {
  private readonly pending = new Map<string, Waiter>();
  /** How recent handoffs ended, so a chat polling for one is told done or not, never left to guess. */
  private readonly settled = new Map<string, HandoffOutcome>();
  /** The AI's calls on each computer, which a person's take-over stops. */
  readonly control = new ComputerControl();
  /** Set while the server closes: what is held then must still be held when it starts again. */
  private frozen = false;

  private readonly file: string | undefined;
  private readonly keepAlive: (computerId: string) => unknown;

  /**
   * @param opts.file where the person's holds and chats' handoffs outlive a
   *   restart of this server. Without it they last as long as this registry.
   * @param opts.keepAlive what an open hold does to its computer's browser
   *   every minute: touch the live page, so it does not close for idleness.
   */
  constructor(opts: { file?: string | undefined; keepAlive?: (computerId: string) => unknown } = {}) {
    this.file = opts.file;
    this.keepAlive = opts.keepAlive ?? livePageFor;
  }

  /** `open`, or how it ended (`done`, `aborted`), or undefined if this server never had it. */
  state(handoffId: string): 'open' | HandoffOutcome | undefined {
    return this.pending.has(handoffId) ? 'open' : this.settled.get(handoffId);
  }

  list(): PendingHandoff[] {
    return [...this.pending.values()].map(({ settle: _s, ...rest }) => rest);
  }

  /**
   * The hold that stops this change, if any: anyone but the person is refused
   * while a handoff holds the computer. Synchronous, so a check and the start
   * of the work it lets through are one step.
   */
  admit(computerId: string, by: 'person' | 'program'): PendingHandoff | undefined {
    if (by === 'person') return undefined;
    return this.list().find((h) => h.computerId === computerId);
  }

  request(
    args: { runId: string; husk: string; reason: string; computerId?: string; takenFrom?: 'console' | 'link'; signal: AbortSignal },
    onRaised: (pending: PendingHandoff) => void,
  ): Promise<HandoffOutcome> {
    if (args.signal.aborted) return Promise.resolve('aborted');

    const record: PendingHandoff = {
      handoffId: id('hnd'),
      runId: args.runId,
      husk: args.husk,
      reason: args.reason,
      ...(args.computerId ? { computerId: args.computerId } : {}),
      createdAt: new Date().toISOString(),
      ...(args.takenFrom ? { takenFrom: args.takenFrom } : {}),
    };

    return new Promise<HandoffOutcome>((resolve) => {
      const onAbort = (): void => this.pending.get(record.handoffId)?.settle('aborted');
      this.hold(record, (outcome) => {
        args.signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      });
      args.signal.addEventListener('abort', onAbort, { once: true });
      onRaised(record);
    });
  }

  /** Open `record`, with nothing waiting on it but `onEnded`: a hold restored after a restart, or one `request` makes. */
  private hold(record: PendingHandoff, onEnded: (outcome: HandoffOutcome) => void): void {
    // The browser closes itself after five idle minutes, and the person may not
    // be looking yet: the page they are coming to use must still be there.
    // Touching it is not use, so the computer's own idle time counts only
    // their typing, never their watching.
    const { computerId } = record;
    const keepAlive = computerId ? setInterval(() => this.keepAlive(computerId), KEEP_ALIVE_MS) : undefined;
    keepAlive?.unref?.();
    const settle = (outcome: HandoffOutcome): void => {
      if (!this.pending.delete(record.handoffId)) return;
      clearInterval(keepAlive);
      this.settled.set(record.handoffId, outcome);
      if (this.settled.size > 500) this.settled.delete(this.settled.keys().next().value as string);
      this.persist();
      onEnded(outcome);
    };
    this.pending.set(record.handoffId, { ...record, settle });
    this.persist();
  }

  /**
   * A person takes the handoff something asked them for: from now on it is
   * their hold, which only their Give back ends, never a chat's hand_off_done.
   */
  claim(handoffId: string, from: 'console' | 'link'): PendingHandoff {
    const waiter = this.pending.get(handoffId);
    if (!waiter) throw notFound('handoff', handoffId);
    waiter.runId = PERSON_RUN;
    waiter.takenFrom = from;
    this.persist();
    return this.get(handoffId);
  }

  /** The server is closing: the holds open now are written as they are, to be restored on its next start. */
  freeze(): void {
    this.frozen = true;
  }

  /** The person's holds and chats' handoffs, written then renamed into place, so a crash never leaves half a file. */
  private persist(): void {
    if (!this.file || this.frozen) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.list().filter(isHold)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Not written, still held: only a restart loses it, and the next change writes it again.
    }
  }

  /**
   * The holds a previous run of this server left open, open again, before it
   * serves anything. A file there but unreadable fails closed: who held which
   * computer is unknown, so every computer `computers` names is held for the
   * person until they give it back.
   */
  async restore(computers: () => Promise<string[]>, onEnded: (handoff: PendingHandoff, outcome: HandoffOutcome) => void): Promise<PendingHandoff[]> {
    if (!this.file || !existsSync(this.file)) return [];
    let holds: PendingHandoff[] | undefined;
    try {
      const records: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(records) && records.every(isHold)) holds = records;
    } catch {
      // read below as unreadable
    }
    if (!holds) {
      try {
        renameSync(this.file, `${this.file}.unreadable-${Date.now()}`);
      } catch {
        // kept where it is; the holds written next replace it
      }
      const at = new Date().toISOString();
      holds = (await computers()).map((computerId) => ({
        handoffId: id('hnd'),
        runId: PERSON_RUN,
        husk: 'you',
        reason: UNREADABLE_HOLDS,
        computerId,
        createdAt: at,
        takenFrom: 'console' as const,
      }));
    }
    for (const h of holds) this.hold(h, (outcome) => onEnded(h, outcome));
    return holds;
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
