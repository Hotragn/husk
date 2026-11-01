import { describe, expect, it, vi } from 'vitest';
import { STOP_UNCONFIRMED } from '@husk-ai/runtime';
import * as ui from '../ui.js';
import { rewriteQuoted, run, strayQuote } from './exec.js';

const exec = vi.fn();
vi.mock('../lib/computers.js', () => ({ resolve: async () => ({ exec }) }));

describe('exec timeout', () => {
  it('says the command was killed only when the computer confirmed it', async () => {
    const warn = vi.spyOn(ui, 'warn').mockImplementation(() => {});
    vi.spyOn(ui, 'note').mockImplementation(() => {});
    const timedOut = { stdout: '', exitCode: 124, timedOut: true, truncated: false, durationMs: 10_000 };

    exec.mockResolvedValueOnce({ ...timedOut, stderr: '' });
    expect(await run(['box', '--timeout', '10', '--', 'sleep 60'])).toBe(124);
    expect(warn).toHaveBeenLastCalledWith('timed out after 10s — the process tree was killed');

    exec.mockResolvedValueOnce({ ...timedOut, stderr: `fly api timed out after 10000ms\n${STOP_UNCONFIRMED}` });
    await run(['box', '--timeout', '10', '--', 'sleep 60']);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('it may still be running inside the computer'));
  });
});

/**
 * The quoting hint exists for one host: cmd.exe, which does not strip single
 * quotes. The documented form `husk exec dev -- 'uname -sr && python3 -V'`
 * therefore reaches husk as argv that still carries the quotes, and without
 * this check the failure surfaces as a raw OCI error naming `'uname`.
 */
describe('exec quoting hint', () => {
  it('catches the command cmd.exe hands over with its quotes attached', () => {
    expect(strayQuote(["'uname", '-sr', '&&', 'python3', "-V'"])).toBe("'uname");
  });

  it('catches an opening quote anywhere in the argv, not only first', () => {
    expect(strayQuote(['sh', '-c', "'echo", "hi'"])).toBe("'echo");
  });

  it('leaves a properly quoted command alone', () => {
    expect(strayQuote(['uname', '-sr'])).toBeUndefined();
    expect(strayQuote(['echo hi > /work/a.txt; cat /work/a.txt'])).toBeUndefined();
  });

  it("leaves a token that is quoted on both sides alone, since that may be deliberate", () => {
    expect(strayQuote(['echo', "'literal'"])).toBeUndefined();
  });

  it('suggests the double-quoted form of what the caller meant', () => {
    expect(rewriteQuoted('dev', ["'uname", '-sr', '&&', 'python3', "-V'"])).toBe(
      'husk exec dev -- "uname -sr && python3 -V"',
    );
  });
});
