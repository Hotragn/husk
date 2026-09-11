import { HuskError } from '@husk/core';
import { describe, expect, it } from 'vitest';
import { assertCommandAllowed, evaluateCommand } from './guard.js';

const none = { allowCommands: [], denyCommands: [] };

describe('evaluateCommand', () => {
  it('allows anything when the husk sets no rules', () => {
    expect(evaluateCommand('rm -rf build', none)).toEqual({ allowed: true });
  });

  it('refuses a command matching a deny pattern', () => {
    const d = evaluateCommand('git push --force origin main', { allowCommands: [], denyCommands: ['push\\s+--force'] });
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe('push\\s+--force');
  });

  it('lets an explicit allow beat a deny', () => {
    const rules = { allowCommands: ['^git push --force origin scratch$'], denyCommands: ['push\\s+--force'] };
    expect(evaluateCommand('git push --force origin scratch', rules).allowed).toBe(true);
    expect(evaluateCommand('git push --force origin main', rules).allowed).toBe(false);
  });

  it('falls back to a substring test when the pattern is not a valid regex', () => {
    const rules = { allowCommands: [], denyCommands: ['curl http://a(b'] };
    expect(evaluateCommand('curl http://a(b', rules).allowed).toBe(false);
    expect(evaluateCommand('curl http://elsewhere', rules).allowed).toBe(true);
  });
});

describe('assertCommandAllowed', () => {
  it('throws an actionable HuskError', () => {
    try {
      assertCommandAllowed('sudo reboot', { allowCommands: [], denyCommands: ['sudo'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HuskError);
      expect((err as HuskError).code).toBe('E_EXEC_DENIED');
      expect((err as HuskError).hint).toContain('allowCommands');
    }
  });

  it('stays quiet when the command is fine', () => {
    expect(() => assertCommandAllowed('ls -la', none)).not.toThrow();
  });
});
