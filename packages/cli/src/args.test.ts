import { describe, expect, it } from 'vitest';
import {
  UsageError,
  parse,
  parseAmount,
  parseChoice,
  parseEnvPairs,
  parseMemory,
  splitRemote,
  splitRest,
} from './args.js';

describe('splitRest', () => {
  it('splits at the first bare --', () => {
    expect(splitRest(['box', '--', 'ls', '-la'])).toEqual({ head: ['box'], rest: ['ls', '-la'], hasRest: true });
  });

  it('keeps a second -- inside the command, where it belongs', () => {
    const { rest } = splitRest(['box', '--', 'git', 'log', '--', 'path']);
    expect(rest).toEqual(['git', 'log', '--', 'path']);
  });

  it('reports no rest when there is no separator', () => {
    expect(splitRest(['box', 'ls'])).toEqual({ head: ['box', 'ls'], rest: [], hasRest: false });
  });

  it('distinguishes an empty command from a missing one', () => {
    expect(splitRest(['box', '--'])).toEqual({ head: ['box'], rest: [], hasRest: true });
  });
});

describe('parse', () => {
  it('accepts global flags on every command', () => {
    const p = parse(['--json', '--quiet', 'x'], {}, 'ps');
    expect(p.values.json).toBe(true);
    expect(p.values.quiet).toBe(true);
    expect(p.positionals).toEqual(['x']);
  });

  it('treats --no-color as colour off, overriding --color', () => {
    expect(parse(['--no-color'], {}, 'ps').values.color).toBe(false);
    expect(parse(['--color'], {}, 'ps').values.color).toBe(true);
    expect(parse([], {}, 'ps').values.color).toBeUndefined();
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    // A silently-ignored --jsno is how a script stops emitting JSON and nobody notices.
    expect(() => parse(['--jsno'], {}, 'ps')).toThrow(UsageError);
    expect(() => parse(['--jsno'], {}, 'ps')).toThrow(/unknown flag --jsno/);
  });

  it('names the command on the usage error so help can be offered', () => {
    try {
      parse(['--nope'], {}, 'exec');
      expect.unreachable();
    } catch (err) {
      expect((err as UsageError).command).toBe('exec');
    }
  });

  it('does not parse the command half of an exec line', () => {
    const p = parse(['box', '--', 'ls', '-la', '--json'], {}, 'exec');
    expect(p.positionals).toEqual(['box']);
    expect(p.rest).toEqual(['ls', '-la', '--json']);
    // --json belonged to ls, not to husk.
    expect(p.values.json).toBe(false);
  });

  it('collects repeated flags', () => {
    const p = parse(['--env', 'A=1', '--env', 'B=2'], { env: { type: 'string', multiple: true } }, 'exec');
    expect(p.values.env).toEqual(['A=1', 'B=2']);
  });

  it('supports short flags', () => {
    expect(parse(['-q'], {}, 'ps').values.quiet).toBe(true);
    expect(parse(['-y'], {}, 'rm').values.yes).toBe(true);
  });
});

describe('parseMemory', () => {
  it.each([
    ['2g', 2048],
    ['2G', 2048],
    ['1.5g', 1536],
    ['512m', 512],
    ['512', 512],
    ['512MB', 512],
  ])('parses %s as %i MB', (input, expected) => {
    expect(parseMemory(input, 'up')).toBe(expected);
  });

  it('passes undefined through', () => {
    expect(parseMemory(undefined, 'up')).toBeUndefined();
  });

  it.each(['big', '-1', '0', '2tb', ''])('rejects %s with an example in the message', (input) => {
    expect(() => parseMemory(input, 'up')).toThrow(/--memory expects a size like 2g|--memory must be positive/);
  });
});

describe('parseChoice', () => {
  it('lists the valid choices when one is wrong', () => {
    expect(() => parseChoice('sideways', ['none', 'egress', 'full'] as const, '--network', 'up')).toThrow(
      /--network must be one of none, egress, full \(got "sideways"\)/,
    );
  });

  it('returns the value when valid', () => {
    expect(parseChoice('full', ['none', 'egress', 'full'] as const, '--network', 'up')).toBe('full');
  });
});

describe('parseEnvPairs', () => {
  it('splits on the first = so values may contain one', () => {
    expect(parseEnvPairs(['URL=http://a?b=c'], 'exec')).toEqual({ URL: 'http://a?b=c' });
  });

  it('rejects a pair with no =', () => {
    expect(() => parseEnvPairs(['JUSTAKEY'], 'exec')).toThrow(/--env expects KEY=VALUE/);
  });

  it('rejects an empty key', () => {
    expect(() => parseEnvPairs(['=value'], 'exec')).toThrow(/--env expects KEY=VALUE/);
  });
});

describe('splitRemote', () => {
  it('splits name:/path', () => {
    expect(splitRemote('box:/work/a.txt')).toEqual({ name: 'box', path: '/work/a.txt' });
  });

  it('accepts an id as the name', () => {
    expect(splitRemote('cmp_abc123:/work')).toEqual({ name: 'cmp_abc123', path: '/work' });
  });

  it('accepts a relative path on the remote side', () => {
    expect(splitRemote('box:work/a.txt')).toEqual({ name: 'box', path: 'work/a.txt' });
  });

  // The Windows trap: a drive letter looks exactly like a remote reference.
  it.each(['C:\\Users\\me\\a.txt', 'c:/Users/me/a.txt', 'D:\\data'])('treats %s as a local path', (input) => {
    expect(splitRemote(input)).toBeNull();
  });

  it('treats a plain path as local', () => {
    expect(splitRemote('./report.csv')).toBeNull();
    expect(splitRemote('/absolute/path')).toBeNull();
    expect(splitRemote('report.csv')).toBeNull();
  });

  it('rejects an empty name or an empty path', () => {
    expect(splitRemote(':/work')).toBeNull();
    expect(splitRemote('box:')).toBeNull();
  });

  it('rejects a name with characters no computer can have', () => {
    expect(splitRemote('has space:/work')).toBeNull();
    expect(splitRemote('http://example.com/x')).toBeNull();
  });
});

describe('parseAmount', () => {
  it('accepts zero, because "spend nothing" is a real instruction', () => {
    expect(parseAmount('0', '--max-cost', 'run')).toBe(0);
  });

  it('accepts decimals and a leading dollar sign', () => {
    expect(parseAmount('0.5', '--max-cost', 'run')).toBe(0.5);
    expect(parseAmount('$2.50', '--max-cost', 'run')).toBe(2.5);
    expect(parseAmount(' 1.25 ', '--max-cost', 'run')).toBe(1.25);
  });

  it('returns undefined when the flag is absent, so the spec default applies', () => {
    expect(parseAmount(undefined, '--max-cost', 'run')).toBeUndefined();
  });

  // The bug this guards: Number('abc') is NaN, every `projected > NaN` is false,
  // and the spend ceiling silently stops existing.
  for (const bad of ['abc', '', '   ', '-5', '-0.01', 'NaN', 'Infinity', '1,5']) {
    it(`rejects ${JSON.stringify(bad)} instead of turning it into NaN`, () => {
      expect(() => parseAmount(bad, '--max-cost', 'run')).toThrowError(/non-negative number/);
    });
  }

  it('names the flag and the offending value in the error', () => {
    expect(() => parseAmount('abc', '--max-cost', 'run')).toThrowError(/--max-cost.*"abc"/);
  });
});
