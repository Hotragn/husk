import { describe, expect, it } from 'vitest';
import { rewriteQuoted, strayQuote } from './exec.js';

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
