import { huskError } from './errors.js';

/**
 * A five-field cron parser and scheduler, written out rather than pulled in.
 *
 * `node-cron` and friends are small, but a scheduler is a thing you must be able to
 * reason about at 3am, and the interesting behaviour -- day-of-month versus
 * day-of-week, month rollovers, times that do not exist because the clock jumped --
 * is exactly the behaviour a dependency hides.
 *
 *     ┌───────────── minute        0-59
 *     │ ┌─────────── hour          0-23
 *     │ │ ┌───────── day of month  1-31
 *     │ │ │ ┌─────── month         1-12 or jan-dec
 *     │ │ │ │ ┌───── day of week   0-7 or sun-sat (0 and 7 are both Sunday)
 *     * * * * *
 */

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export interface CronExpression {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /**
   * Vixie cron's oddest rule: when both day fields are restricted the job runs on
   * the union, not the intersection. `0 0 1 * mon` is "the 1st, and every Monday".
   */
  readonly dayUnion: boolean;
}

function fail(source: string, detail: string): never {
  throw huskError('E_SPEC_INVALID', `invalid cron expression "${source}": ${detail}`, {
    hint: 'five space-separated fields: minute hour day-of-month month day-of-week (or @daily, @hourly, ...)',
  });
}

function parseAtom(source: string, atom: string, min: number, max: number, names: string[] | undefined): number {
  const lower = atom.toLowerCase();
  if (names) {
    const byName = names.indexOf(lower.slice(0, 3));
    if (byName >= 0) return byName + (names === MONTH_NAMES ? 1 : 0);
  }
  if (!/^\d+$/.test(lower)) fail(source, `"${atom}" is not a number or a known name`);
  const n = Number.parseInt(lower, 10);
  if (n < min || n > max) fail(source, `"${atom}" is outside ${min}-${max}`);
  return n;
}

function parseField(
  source: string,
  field: string,
  min: number,
  max: number,
  names?: string[],
): { values: Set<number>; wildcard: boolean } {
  const values = new Set<number>();
  let wildcard = false;

  for (const part of field.split(',')) {
    if (part === '') fail(source, 'empty list item');
    const [rangePart, stepPart, ...extra] = part.split('/');
    if (extra.length > 0) fail(source, `"${part}" has more than one step`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) fail(source, `step "${stepPart}" is not a number`);
      step = Number.parseInt(stepPart, 10);
      if (step === 0) fail(source, 'step must be at least 1');
    }

    let lo: number;
    let hi: number;
    const range = rangePart ?? '';
    if (range === '*' || range === '?') {
      lo = min;
      hi = max;
      if (step === 1) wildcard = true;
    } else if (range.includes('-')) {
      const [a, b, ...rest] = range.split('-');
      if (rest.length > 0 || a === undefined || b === undefined || b === '') fail(source, `"${range}" is not a range`);
      lo = parseAtom(source, a, min, max, names);
      hi = parseAtom(source, b, min, max, names);
      if (lo > hi) fail(source, `range "${range}" runs backwards`);
    } else {
      lo = parseAtom(source, range, min, max, names);
      // `5/15` means "from 5 to the end of the field, every 15" -- not "just 5".
      hi = stepPart !== undefined ? max : lo;
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  if (values.size === 0) fail(source, 'matched nothing');
  return { values, wildcard };
}

export function parseCron(expression: string): CronExpression {
  const source = expression.trim();
  if (!source) fail(expression, 'empty');
  const expanded = MACROS[source.toLowerCase()] ?? source;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    fail(source, `expected 5 fields, got ${fields.length}${fields.length === 6 ? ' (seconds are not supported)' : ''}`);
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  const minutes = parseField(source, minute, 0, 59);
  const hours = parseField(source, hour, 0, 23);
  const daysOfMonth = parseField(source, dom, 1, 31);
  const months = parseField(source, month, 1, 12, MONTH_NAMES);
  const daysOfWeek = parseField(source, dow, 0, 7, DOW_NAMES);

  // 7 and 0 are both Sunday; normalise so matching is a single lookup.
  const normalisedDow = new Set<number>();
  for (const d of daysOfWeek.values) normalisedDow.add(d === 7 ? 0 : d);

  return {
    source,
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: normalisedDow,
    dayUnion: !daysOfMonth.wildcard && !daysOfWeek.wildcard,
  };
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function dayMatches(expr: CronExpression, year: number, monthIndex: number, day: number): boolean {
  const dom = expr.daysOfMonth.has(day);
  const dow = expr.daysOfWeek.has(new Date(year, monthIndex, day).getDay());
  return expr.dayUnion ? dom || dow : dom && dow;
}

/**
 * Build a local `Date`, or null when that calendar date does not exist.
 *
 * A local time inside a spring-forward gap (02:30 on a US spring Sunday) does not
 * exist either, but JS normalises it to the first real instant afterwards and we
 * keep that: a daily 02:30 job firing at 03:00 once a year is the behaviour an
 * operator expects, and silently skipping the day is the behaviour that pages them.
 */
function localTime(year: number, monthIndex: number, day: number, hour: number, minute: number): Date | null {
  const d = new Date(year, monthIndex, day, hour, minute, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== monthIndex || d.getDate() !== day) return null;
  return d;
}

/**
 * The first firing strictly after `after`, in the host's local timezone.
 *
 * Field-wise descent rather than minute-by-minute scanning: `0 0 29 2 *` is four
 * years away and must not cost two million iterations to find.
 */
export function nextFireTime(expr: CronExpression, after: Date = new Date()): Date | null {
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  let year = start.getFullYear();
  let monthIndex = start.getMonth();
  let day = start.getDate();
  let hour = start.getHours();
  let minute = start.getMinutes();
  const horizon = year + 5;

  for (let guard = 0; guard < 10_000; guard++) {
    if (year > horizon) return null;

    if (!expr.months.has(monthIndex + 1)) {
      monthIndex += 1;
      if (monthIndex > 11) {
        monthIndex = 0;
        year += 1;
      }
      day = 1;
      hour = 0;
      minute = 0;
      continue;
    }

    if (day > daysInMonth(year, monthIndex) || !dayMatches(expr, year, monthIndex, day)) {
      day += 1;
      if (day > daysInMonth(year, monthIndex)) {
        day = 1;
        monthIndex += 1;
        if (monthIndex > 11) {
          monthIndex = 0;
          year += 1;
        }
      }
      hour = 0;
      minute = 0;
      continue;
    }

    if (!expr.hours.has(hour)) {
      hour += 1;
      minute = 0;
      if (hour > 23) {
        hour = 0;
        day += 1;
      }
      continue;
    }

    if (!expr.minutes.has(minute)) {
      minute += 1;
      if (minute > 59) {
        minute = 0;
        hour += 1;
        if (hour > 23) {
          hour = 0;
          day += 1;
        }
      }
      continue;
    }

    const candidate = localTime(year, monthIndex, day, hour, minute);
    if (candidate && candidate.getTime() > after.getTime()) return candidate;

    // Either the date does not exist, or the clock shifted us back onto or before
    // `after` (a fall-back repeat). Step one minute and keep looking.
    minute += 1;
    if (minute > 59) {
      minute = 0;
      hour += 1;
      if (hour > 23) {
        hour = 0;
        day += 1;
      }
    }
  }
  return null;
}

/** Convenience for `husk validate` and the console. */
export function nextFireTimes(expr: CronExpression, count: number, after: Date = new Date()): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextFireTime(expr, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

export interface CronJob {
  readonly id: string;
  readonly expression: CronExpression;
  readonly run: (firedAt: Date) => void | Promise<void>;
  /** The firing this job is currently waiting for. Only ever moves forward. */
  nextAt: Date | null;
}

/** setTimeout clamps above this and fires immediately, which would busy-loop. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Timers routinely fire a millisecond or two early; treat that as on time. */
const EARLY_SKEW_MS = 750;

/**
 * A single-timer scheduler.
 *
 * One timer for the whole set, always aimed at the earliest next firing, rather
 * than one interval per job. Each job carries the firing it is waiting for, so an
 * early timer cannot double-fire a slot and a slept-through night is not replayed:
 * the laptop wakes up and runs the next occurrence, not 480 of them.
 */
export class CronScheduler {
  private readonly jobs = new Map<string, CronJob>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly now: () => Date;
  private readonly onError: (err: unknown, job: CronJob) => void;

  constructor(opts: { now?: () => Date; onError?: (err: unknown, job: CronJob) => void } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError ?? (() => undefined);
  }

  add(id: string, expression: string, run: CronJob['run']): CronJob {
    const parsed = parseCron(expression);
    const job: CronJob = { id, expression: parsed, run, nextAt: nextFireTime(parsed, this.now()) };
    this.jobs.set(id, job);
    if (this.running) this.arm();
    return job;
  }

  remove(id: string): boolean {
    const had = this.jobs.delete(id);
    if (had && this.running) this.arm();
    return had;
  }

  get size(): number {
    return this.jobs.size;
  }

  list(): Array<{ id: string; expression: string; nextAt: string | null }> {
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      expression: j.expression.source,
      nextAt: j.nextAt ? j.nextAt.toISOString() : null,
    }));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const now = this.now();
    for (const job of this.jobs.values()) job.nextAt ??= nextFireTime(job.expression, now);
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running || this.jobs.size === 0) return;

    let soonest = Number.POSITIVE_INFINITY;
    for (const job of this.jobs.values()) {
      if (job.nextAt) soonest = Math.min(soonest, job.nextAt.getTime());
    }
    if (!Number.isFinite(soonest)) return;

    const delay = Math.min(Math.max(soonest - this.now().getTime(), 1), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  /**
   * Fire everything due at `at` and advance each job past it. Exposed so tests can
   * drive the scheduler on a fake clock instead of waiting for wall time.
   */
  fireDue(at: Date = this.now()): CronJob[] {
    const fired: CronJob[] = [];
    for (const job of this.jobs.values()) {
      if (!job.nextAt) continue;
      if (job.nextAt.getTime() > at.getTime() + EARLY_SKEW_MS) continue;
      const firedAt = job.nextAt;
      // Advance before running, so a slow job cannot be re-entered by the next tick
      // and an overdue job catches up to the present instead of replaying the gap.
      job.nextAt = nextFireTime(job.expression, new Date(Math.max(firedAt.getTime(), at.getTime())));
      fired.push(job);
      try {
        const maybe = job.run(firedAt);
        if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
          void (maybe as Promise<void>).catch((err: unknown) => this.onError(err, job));
        }
      } catch (err) {
        this.onError(err, job);
      }
    }
    return fired;
  }

  private tick(): void {
    if (!this.running) return;
    this.fireDue(this.now());
    this.arm();
  }
}
