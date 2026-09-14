import { describe, expect, it } from 'vitest';
import { HuskError, RESERVED_ERROR_CODES, isHuskError } from './errors.js';

/**
 * `E_EXEC_TIMEOUT` and `E_STEP_LIMIT` are declared and never thrown.
 *
 * That is deliberate -- both conditions surface as data (`ExecResult.timedOut`,
 * `RunResult.stopReason`) so the caller keeps the output instead of losing it
 * to an exception. The codes stay because `@husk-ai/server` maps `E_EXEC_TIMEOUT`
 * to 504 and `@husk-ai/sdk` decodes 504 back to it.
 *
 * The compile-time half of this guard is the `satisfies readonly
 * HuskErrorCode[]` on the constant: delete either code from the union and
 * `tsc` fails at the declaration rather than somewhere downstream. This is the
 * run-time half.
 */
describe('reserved error codes', () => {
  it('names exactly the two codes husk never throws', () => {
    expect([...RESERVED_ERROR_CODES]).toEqual(['E_EXEC_TIMEOUT', 'E_STEP_LIMIT']);
  });

  it('are usable as real codes when a boundary needs to name one', () => {
    for (const code of RESERVED_ERROR_CODES) {
      const err = new HuskError(code, `${code} arrived from a gateway`, { hint: 'retry with a longer timeout' });
      expect(isHuskError(err)).toBe(true);
      expect(err.code).toBe(code);
      expect(err.toJSON()).toMatchObject({ code, hint: 'retry with a longer timeout' });
    }
  });
});
