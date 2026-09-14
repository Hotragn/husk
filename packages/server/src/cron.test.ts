import { describe, expect, it } from 'vitest';
import { CronScheduler, nextFireTime, nextFireTimes, parseCron } from './cron.js';

/** Local-time ISO, so assertions read the way an operator reads a crontab. */
function local(d: Date | null): string {
  if (!d) return 'never';
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function at(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

function next(expr: string, from: Date): string {
  return local(nextFireTime(parseCron(expr), from));
}

describe('parseCron', () => {
  it('parses the five fields', () => {
    const e = parseCron('5 4 * * 0');
    expect([...e.minutes]).toEqual([5]);
    expect([...e.hours]).toEqual([4]);
    expect(e.daysOfMonth.size).toBe(31);
    expect(e.months.size).toBe(12);
    expect([...e.daysOfWeek]).toEqual([0]);
    expect(e.dayUnion).toBe(false);
  });

  it('treats 7 and 0 as the same Sunday', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
    expect([...parseCron('0 0 * * 0,7').daysOfWeek]).toEqual([0]);
  });

  it('accepts month and weekday names, case-insensitively', () => {
    expect([...parseCron('0 0 1 JAN *').months]).toEqual([1]);
    expect([...parseCron('0 0 1 dec *').months]).toEqual([12]);
    expect([...parseCron('0 0 * * Mon-Fri').daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('expands step values over the whole field', () => {
    expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 */6 * * *').hours]).toEqual([0, 6, 12, 18]);
  });

  it('expands a stepped range', () => {
    expect([...parseCron('10-30/10 * * * *').minutes]).toEqual([10, 20, 30]);
  });

  it('reads a bare value with a step as "from here on"', () => {
    expect([...parseCron('5/15 * * * *').minutes]).toEqual([5, 20, 35, 50]);
  });

  it('expands comma lists of atoms and ranges', () => {
    expect([...parseCron('0,5,10-12 * * * *').minutes]).toEqual([0, 5, 10, 11, 12]);
  });

  it('treats ? as a wildcard', () => {
    expect(parseCron('0 0 ? * MON').dayUnion).toBe(false);
    expect(parseCron('0 0 1 * ?').dayUnion).toBe(false);
  });

  it('expands macros', () => {
    expect(parseCron('@daily').source).toBe('@daily');
    expect([...parseCron('@daily').hours]).toEqual([0]);
    expect([...parseCron('@weekly').daysOfWeek]).toEqual([0]);
    expect([...parseCron('@yearly').months]).toEqual([1]);
  });

  it('sets dayUnion only when both day fields are restricted', () => {
    expect(parseCron('0 0 * * *').dayUnion).toBe(false);
    expect(parseCron('0 0 15 * *').dayUnion).toBe(false);
    expect(parseCron('0 0 * * 1').dayUnion).toBe(false);
    expect(parseCron('0 0 15 * 1').dayUnion).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['* * * *', 'four fields'],
    ['* * * * * *', 'six fields'],
    ['60 * * * *', 'minute out of range'],
    ['* 24 * * *', 'hour out of range'],
    ['* * 0 * *', 'day of month zero'],
    ['* * 32 * *', 'day of month too high'],
    ['* * * 13 *', 'month too high'],
    ['* * * * 8', 'weekday too high'],
    ['30-10 * * * *', 'backwards range'],
    ['*/0 * * * *', 'zero step'],
    ['*/a * * * *', 'non-numeric step'],
    ['bogus * * * *', 'unknown name'],
    ['1,, * * * *', 'empty list item'],
  ])('rejects %s (%s)', (expr) => {
    expect(() => parseCron(expr)).toThrow(/invalid cron expression/);
  });

  it('names seconds explicitly when given six fields', () => {
    expect(() => parseCron('* * * * * *')).toThrow(/seconds are not supported/);
  });
});

describe('nextFireTime', () => {
  it('never returns a time at or before the reference instant', () => {
    const ref = at(2025, 6, 10, 12, 0);
    const n = nextFireTime(parseCron('* * * * *'), ref)!;
    expect(n.getTime()).toBeGreaterThan(ref.getTime());
    expect(local(n)).toBe('2025-06-10 12:01');
  });

  it('ignores seconds already elapsed in the current minute', () => {
    const ref = new Date(2025, 5, 10, 12, 0, 59, 999);
    expect(local(nextFireTime(parseCron('* * * * *'), ref))).toBe('2025-06-10 12:01');
  });

  it('rolls over the hour', () => {
    expect(next('0 * * * *', at(2025, 6, 10, 12, 30))).toBe('2025-06-10 13:00');
  });

  it('rolls over the day', () => {
    expect(next('0 9 * * *', at(2025, 6, 10, 12, 0))).toBe('2025-06-11 09:00');
  });

  it('rolls over the month', () => {
    expect(next('0 0 1 * *', at(2025, 1, 15, 3, 0))).toBe('2025-02-01 00:00');
  });

  it('rolls over the year', () => {
    expect(next('0 0 1 1 *', at(2025, 6, 10))).toBe('2026-01-01 00:00');
  });

  it('skips months that cannot host the requested day', () => {
    // The 31st exists in Jan, Mar, May, Jul, Aug, Oct, Dec -- not February.
    expect(next('0 0 31 * *', at(2025, 1, 31, 1, 0))).toBe('2025-03-31 00:00');
  });

  it('finds Feb 29 across the leap gap', () => {
    expect(next('0 0 29 2 *', at(2025, 3, 1))).toBe('2028-02-29 00:00');
  });

  it('returns null when the schedule cannot occur inside the horizon', () => {
    // Feb 30 never happens.
    expect(nextFireTime(parseCron('0 0 30 2 *'), at(2025, 1, 1))).toBeNull();
  });

  it('handles the last day of a 30-day month', () => {
    expect(next('0 0 30 * *', at(2025, 4, 30, 1, 0))).toBe('2025-05-30 00:00');
  });

  it('matches day-of-week', () => {
    // 2025-06-10 is a Tuesday; the next Monday is the 16th.
    expect(next('0 0 * * 1', at(2025, 6, 10, 12, 0))).toBe('2025-06-16 00:00');
  });

  it('unions day-of-month and day-of-week when both are restricted', () => {
    // "the 15th, or any Monday". From Tue Jun 10 2025 the next Monday is Jun 16,
    // but the 15th (a Sunday) comes first.
    expect(next('0 0 15 * 1', at(2025, 6, 10, 12, 0))).toBe('2025-06-15 00:00');
    expect(next('0 0 15 * 1', at(2025, 6, 15, 12, 0))).toBe('2025-06-16 00:00');
  });

  it('intersects nothing when only one day field is restricted', () => {
    // Plain day-of-month: June 15 then July 15, regardless of weekday.
    expect(nextFireTimes(parseCron('0 0 15 * *'), 2, at(2025, 6, 1)).map(local)).toEqual([
      '2025-06-15 00:00',
      '2025-07-15 00:00',
    ]);
  });

  it('walks a stepped schedule in order', () => {
    expect(nextFireTimes(parseCron('*/20 * * * *'), 4, at(2025, 6, 10, 23, 10)).map(local)).toEqual([
      '2025-06-10 23:20',
      '2025-06-10 23:40',
      '2025-06-11 00:00',
      '2025-06-11 00:20',
    ]);
  });

  it('walks a weekday-business-hours schedule across a weekend', () => {
    // Fri 2025-06-13 17:00 -> next weekday 09:00 is Monday the 16th.
    expect(next('0 9 * * 1-5', at(2025, 6, 13, 17, 0))).toBe('2025-06-16 09:00');
  });

  it('is monotonic over a full year of a minute-granular schedule', () => {
    const expr = parseCron('*/7 */3 * * *');
    let cursor = at(2025, 1, 1, 0, 0);
    for (let i = 0; i < 2000; i++) {
      const n = nextFireTime(expr, cursor);
      expect(n).not.toBeNull();
      expect(n!.getTime()).toBeGreaterThan(cursor.getTime());
      cursor = n!;
    }
  });
});

/**
 * DST is where cron implementations quietly differ. These run in whatever zone the
 * host is in, so they assert invariants rather than wall-clock strings: no
 * duplicates, no skipped days, always forward.
 */
describe('nextFireTime around DST transitions', () => {
  const transitions = [
    { name: 'northern spring forward', from: at(2025, 3, 8, 12, 0) },
    { name: 'northern fall back', from: at(2025, 11, 1, 12, 0) },
    { name: 'southern spring forward', from: at(2025, 10, 4, 12, 0) },
    { name: 'southern fall back', from: at(2025, 4, 5, 12, 0) },
  ];

  for (const t of transitions) {
    it(`fires a daily 02:30 job exactly once a day across ${t.name}`, () => {
      const fires = nextFireTimes(parseCron('30 2 * * *'), 4, t.from);
      expect(fires).toHaveLength(4);
      const days = new Set(fires.map((d) => local(d).slice(0, 10)));
      expect(days.size).toBe(4);
      for (let i = 1; i < fires.length; i++) {
        expect(fires[i]!.getTime()).toBeGreaterThan(fires[i - 1]!.getTime());
      }
    });

    it(`never repeats or reverses a half-hourly schedule across ${t.name}`, () => {
      const fires = nextFireTimes(parseCron('0,30 * * * *'), 120, t.from);
      const seen = new Set<number>();
      for (let i = 0; i < fires.length; i++) {
        const ms = fires[i]!.getTime();
        expect(seen.has(ms)).toBe(false);
        seen.add(ms);
        if (i > 0) expect(ms).toBeGreaterThan(fires[i - 1]!.getTime());
      }
      expect(fires).toHaveLength(120);
    });
  }
});

describe('CronScheduler', () => {
  it('fires a job once per slot on a fake clock', () => {
    let clock = at(2025, 6, 10, 8, 59);
    const fired: string[] = [];
    const s = new CronScheduler({ now: () => clock });
    s.add('hourly', '0 * * * *', (d) => void fired.push(local(d)));

    s.fireDue(clock);
    expect(fired).toEqual([]);

    clock = at(2025, 6, 10, 9, 0);
    s.fireDue(clock);
    expect(fired).toEqual(['2025-06-10 09:00']);

    // Same slot again must not re-fire.
    s.fireDue(clock);
    s.fireDue(at(2025, 6, 10, 9, 30));
    expect(fired).toEqual(['2025-06-10 09:00']);

    s.fireDue(at(2025, 6, 10, 10, 0));
    expect(fired).toEqual(['2025-06-10 09:00', '2025-06-10 10:00']);
  });

  it('does not replay slots missed while the process was asleep', () => {
    let clock = at(2025, 6, 10, 0, 0);
    const fired: string[] = [];
    const s = new CronScheduler({ now: () => clock });
    const job = s.add('hourly', '0 * * * *', (d) => void fired.push(local(d)));

    // Seven hours pass with the process suspended.
    clock = at(2025, 6, 10, 8, 0);
    s.fireDue(clock);
    expect(fired).toEqual(['2025-06-10 01:00']);
    // One catch-up firing, then straight back onto the live schedule -- not eight.
    expect(local(job.nextAt)).toBe('2025-06-10 09:00');
    s.fireDue(clock);
    expect(fired).toHaveLength(1);
  });

  it('tolerates a timer that fires a few milliseconds early', () => {
    const slot = at(2025, 6, 10, 9, 0);
    const fired: Date[] = [];
    const s = new CronScheduler({ now: () => at(2025, 6, 10, 8, 30) });
    s.add('hourly', '0 * * * *', (d) => void fired.push(d));
    s.fireDue(new Date(slot.getTime() - 3));
    expect(fired.map(local)).toEqual(['2025-06-10 09:00']);
  });

  it('reports the next firing and removes jobs', () => {
    const clock = at(2025, 6, 10, 8, 30);
    const s = new CronScheduler({ now: () => clock });
    s.add('a', '0 9 * * *', () => undefined);
    expect(s.size).toBe(1);
    expect(s.list()[0]!.nextAt).toBe(at(2025, 6, 10, 9, 0).toISOString());
    expect(s.remove('a')).toBe(true);
    expect(s.remove('a')).toBe(false);
    expect(s.size).toBe(0);
  });

  it('routes a throwing job to onError instead of an unhandled rejection', async () => {
    const clock = at(2025, 6, 10, 8, 30);
    const errors: unknown[] = [];
    const s = new CronScheduler({ now: () => clock, onError: (e) => void errors.push(e) });
    s.add('sync', '0 * * * *', () => {
      throw new Error('sync boom');
    });
    s.add('async', '0 * * * *', async () => {
      throw new Error('async boom');
    });
    s.fireDue(at(2025, 6, 10, 9, 0));
    await new Promise((r) => setImmediate(r));
    expect(errors.map((e) => (e as Error).message).sort()).toEqual(['async boom', 'sync boom']);
  });

  it('rejects an invalid expression at add time, not at fire time', () => {
    const s = new CronScheduler();
    expect(() => s.add('bad', 'not a cron', () => undefined)).toThrow(/invalid cron expression/);
    expect(s.size).toBe(0);
  });
});
