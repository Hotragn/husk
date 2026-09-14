/**
 * Two of these are reserved rather than live. See `RESERVED_ERROR_CODES`.
 */
export type HuskErrorCode =
  | 'E_PROVIDER_UNAVAILABLE'
  | 'E_COMPUTER_NOT_FOUND'
  | 'E_COMPUTER_FAILED'
  | 'E_EXEC_FAILED'
  /**
   * Reserved. Nothing throws this.
   *
   * An exec that runs out of time still produces stdout, stderr and an exit
   * code, and the caller usually wants all three -- so a timeout is reported as
   * `ExecResult.timedOut: true`, not as a thrown error. Throwing would discard
   * the output the agent needs in order to explain what happened.
   *
   * Kept because it is the honest code for the *status* of such a result: the
   * server maps it to 504 and `@husk-ai/sdk` decodes 504 back to it, so a proxy or
   * gateway timing out a request still round-trips into a sensible `HuskError`.
   */
  | 'E_EXEC_TIMEOUT'
  | 'E_EXEC_DENIED'
  | 'E_FS_DENIED'
  | 'E_QUOTA'
  | 'E_MODEL_UNAVAILABLE'
  | 'E_MODEL_ERROR'
  | 'E_NO_CREDENTIALS'
  | 'E_SPEC_INVALID'
  | 'E_IMPORT_FAILED'
  | 'E_TOOL_ERROR'
  | 'E_BUDGET_EXCEEDED'
  /**
   * Reserved. Nothing throws this.
   *
   * Hitting `limits.maxSteps` is a normal ending, not a failure: the run has
   * real text, real messages and real usage to return, and the caller learns
   * why it stopped from `RunResult.stopReason: 'step_limit'`. Throwing here
   * would throw the run away with it.
   */
  | 'E_STEP_LIMIT'
  | 'E_ABORTED'
  | 'E_NOT_IMPLEMENTED'
  | 'E_CONFIG'
  | 'E_INTERNAL';

/**
 * Codes that are part of the contract but are never thrown by husk itself.
 *
 * They are declared so the status mapping in `@husk-ai/server` and the decoder in
 * `@husk-ai/sdk` have something to name, and so removing one is a deliberate
 * breaking change rather than an accident. The condition each describes
 * surfaces as data -- `ExecResult.timedOut`, `RunResult.stopReason` -- because
 * a timeout or a step ceiling is a result the caller wants to read, not an
 * exception that destroys it.
 */
export const RESERVED_ERROR_CODES = ['E_EXEC_TIMEOUT', 'E_STEP_LIMIT'] as const satisfies readonly HuskErrorCode[];

export class HuskError extends Error {
  readonly code: HuskErrorCode;
  readonly details?: Record<string, unknown>;
  /** A one-line, human-actionable next step. Surfaced verbatim by the CLI. */
  readonly hint?: string;

  constructor(
    code: HuskErrorCode,
    message: string,
    opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'HuskError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

export function isHuskError(e: unknown): e is HuskError {
  return e instanceof HuskError;
}

/** Never throw from a cleanup path. */
export async function quiet<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
