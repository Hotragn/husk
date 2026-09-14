import { describe, expect, it } from 'vitest';
import { findSubcommand } from './bin.js';
import { COMMANDS, commandHelp, findCommand, suggest, topLevelHelp } from './help.js';

describe('findSubcommand', () => {
  it('finds the command after global flags', () => {
    expect(findSubcommand(['--json', 'ps'])).toEqual({ name: 'ps', rest: ['--json'] });
  });

  it('finds a leading command and keeps its own flags', () => {
    expect(findSubcommand(['ps', '--all'])).toEqual({ name: 'ps', rest: ['--all'] });
  });

  it('returns no command for a bare flag line', () => {
    expect(findSubcommand(['--help'])).toEqual({ name: undefined, rest: ['--help'] });
    expect(findSubcommand([])).toEqual({ name: undefined, rest: [] });
  });

  it('never looks past a bare --, so an exec payload cannot be mistaken for a command', () => {
    expect(findSubcommand(['--', 'ps'])).toEqual({ name: undefined, rest: ['--', 'ps'] });
  });

  it('keeps the exec payload intact', () => {
    expect(findSubcommand(['exec', 'box', '--', 'ls', '-la'])).toEqual({
      name: 'exec',
      rest: ['box', '--', 'ls', '-la'],
    });
  });
});

describe('help content', () => {
  it('gives every command a summary, a usage line and a runnable example', () => {
    for (const c of COMMANDS) {
      expect(c.summary, `${c.name} summary`).toBeTruthy();
      expect(c.usage, `${c.name} usage`).toMatch(/^husk /);
      expect(c.examples.length, `${c.name} examples`).toBeGreaterThan(0);
      for (const ex of c.examples) expect(ex, `${c.name} example`).toMatch(/husk|claude/);
    }
  });

  it('renders per-command help with usage and examples', () => {
    const text = commandHelp(findCommand('exec')!);
    expect(text).toContain('husk exec <name|id> -- <command...>');
    expect(text).toContain('EXAMPLES');
    expect(text).toContain('uname -sr');
  });

  it('warns in `exec` help that the exit code is the child\'s', () => {
    expect(commandHelp(findCommand('exec')!)).toMatch(/exit code/i);
  });

  it('says in `shell` help that it is not a pty', () => {
    expect(commandHelp(findCommand('shell')!)).toMatch(/not a pty/i);
  });

  it('lists every routable command in the top-level help', () => {
    const text = topLevelHelp('0.1.0');
    for (const c of COMMANDS) expect(text, c.name).toContain(c.name);
  });

  it('documents the exit codes where a script author will see them', () => {
    expect(topLevelHelp('0.1.0')).toContain('0 ok');
    expect(topLevelHelp('0.1.0')).toContain('130');
  });
});

describe('suggestions', () => {
  it.each([
    ['docter', 'doctor'],
    ['exce', 'exec'],
    ['vaildate', 'validate'],
    ['moduls', 'models'],
  ])('suggests %s -> %s', (typo, expected) => {
    expect(suggest(typo)).toBe(expected);
  });

  it('says nothing rather than guessing wildly', () => {
    expect(suggest('kubernetes')).toBeUndefined();
  });
});
