import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ui from './ui.js';

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const stdout = () => out.join('');
const stderr = () => err.join('');

describe('the stdout contract', () => {
  it('sends the answer to stdout and chatter to stderr', () => {
    ui.configure({ color: false });
    ui.print('the answer');
    ui.note('chatter');
    ui.warn('careful');
    expect(stdout()).toBe('the answer\n');
    expect(stderr()).toContain('chatter');
    expect(stderr()).toContain('careful');
  });

  it('puts nothing but JSON on stdout under --json', () => {
    ui.configure({ color: false, json: true });
    ui.print('this must not appear');
    ui.raw('nor this');
    ui.note('chatter');
    ui.warn('careful');
    ui.step('done');
    ui.json({ ok: true });
    // The whole of stdout must parse. This is what makes `| jq` safe.
    expect(JSON.parse(stdout())).toEqual({ ok: true });
  });

  it('still reports errors under --quiet, because a silent failure is worse', () => {
    ui.configure({ color: false, quiet: true });
    ui.note('suppressed');
    ui.warn('suppressed');
    ui.fail('not suppressed');
    expect(stderr()).toBe('error not suppressed\n');
  });

  it('suppresses debug lines unless --debug', () => {
    ui.configure({ color: false });
    ui.debug('internal');
    expect(stderr()).toBe('');
    ui.configure({ color: false, debug: true });
    ui.debug('internal');
    expect(stderr()).toContain('internal');
  });
});

describe('colour', () => {
  it('is off when NO_COLOR is set, whatever the caller asked for', () => {
    vi.stubEnv('NO_COLOR', '1');
    ui.configure({ color: true });
    expect(ui.red('x')).toBe('x');
  });

  it('is off when stdout and stderr are both not terminals', () => {
    ui.configure({});
    expect(ui.options().color).toBe(false);
    expect(ui.green('x')).toBe('x');
  });

  it('is on when FORCE_COLOR is set even without a terminal, for CI logs', () => {
    vi.stubEnv('FORCE_COLOR', '1');
    ui.configure({});
    expect(ui.red('x')).toContain('31m');
  });

  it('is off for TERM=dumb', () => {
    vi.stubEnv('TERM', 'dumb');
    ui.configure({ color: true });
    expect(ui.red('x')).toBe('x');
  });

  it('is off when --no-color is passed', () => {
    vi.stubEnv('FORCE_COLOR', '1');
    ui.configure({ color: false });
    expect(ui.red('x')).toBe('x');
  });
});

describe('table', () => {
  it('is tab-separated with no padding when piped, so cut and awk work', () => {
    ui.configure({});
    const rendered = ui.table([{ header: 'name' }, { header: 'id' }], [['box', 'cmp_1'], ['other', 'cmp_2']]);
    expect(rendered).toBe('name\tid\nbox\tcmp_1\nother\tcmp_2');
    for (const line of rendered.split('\n')) expect(line).not.toMatch(/ {2}/);
  });

  it('strips colour from cells when piped', () => {
    vi.stubEnv('FORCE_COLOR', '1');
    ui.configure({});
    const rendered = ui.table([{ header: 'state' }], [[ui.green('running')]]);
    expect(rendered).toBe('state\nrunning');
  });
});

describe('text helpers', () => {
  it('measures visible length, ignoring escape codes', () => {
    vi.stubEnv('FORCE_COLOR', '1');
    ui.configure({ color: true });
    expect(ui.visibleLength(ui.red('abc'))).toBe(3);
    expect(ui.pad(ui.red('ab'), 5)).toHaveLength(ui.red('ab').length + 3);
  });

  it('elides with a marker rather than cutting silently', () => {
    ui.configure({ color: false });
    expect(ui.truncate('abcdefghij', 5)).toBe('abcd…');
    expect(ui.truncate('abc', 10)).toBe('abc');
  });
});

describe('spinner', () => {
  it('does not animate when stderr is not a terminal', () => {
    ui.configure({ color: false });
    const s = ui.spinner('working');
    s.stop();
    // One static line, and no cursor movement that would corrupt a CI log.
    expect(stderr()).toBe('working...\n');
    expect(stderr()).not.toContain('\r');
  });

  it('says nothing at all under --quiet', () => {
    ui.configure({ color: false, quiet: true });
    ui.spinner('working').stop('done');
    expect(stderr()).toBe('');
  });
});
