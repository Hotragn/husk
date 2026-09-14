import { HuskError } from '@husk/core';
import type { HuskErrorCode } from '@husk/core';

/**
 * The wire shape of a control-plane failure.
 *
 * Every non-2xx response from `@husk/server` carries this body. Anything that
 * does not is either a proxy, a crash, or the wrong port, and the SDK says so
 * rather than pretending it understood.
 */
export interface WireErrorBody {
  error: {
    code?: string;
    message?: string;
    hint?: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Codes the server emits that `HuskErrorCode` does not declare.
 *
 * `packages/server/src/errors.ts` declares these and casts them into `HuskError`
 * in exactly one place. The SDK has to know the same list, or it cannot tell a
 * missing husk from a missing computer -- which is precisely the bug that made
 * every 404 decode as `E_COMPUTER_NOT_FOUND`.
 */
export const SERVER_ERROR_CODES = [
  'E_HUSK_NOT_FOUND',
  'E_RUN_NOT_FOUND',
  'E_APPROVAL_NOT_FOUND',
  'E_TRANSCRIPT_NOT_FOUND',
  'E_ROUTE_NOT_FOUND',
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

/** Everything that can legitimately appear in `error.code` on the wire. */
export type HuskWireErrorCode = HuskErrorCode | ServerErrorCode;

const CORE_CODES = [
  'E_PROVIDER_UNAVAILABLE',
  'E_COMPUTER_NOT_FOUND',
  'E_COMPUTER_FAILED',
  'E_EXEC_FAILED',
  'E_EXEC_TIMEOUT',
  'E_EXEC_DENIED',
  'E_FS_DENIED',
  'E_QUOTA',
  'E_MODEL_UNAVAILABLE',
  'E_MODEL_ERROR',
  'E_NO_CREDENTIALS',
  'E_SPEC_INVALID',
  'E_IMPORT_FAILED',
  'E_TOOL_ERROR',
  'E_BUDGET_EXCEEDED',
  'E_STEP_LIMIT',
  'E_ABORTED',
  'E_NOT_IMPLEMENTED',
  'E_CONFIG',
  'E_INTERNAL',
] as const satisfies readonly HuskErrorCode[];

export const KNOWN_CODES: ReadonlySet<string> = new Set<string>([...CORE_CODES, ...SERVER_ERROR_CODES]);

export function isKnownErrorCode(code: string): code is HuskWireErrorCode {
  return KNOWN_CODES.has(code);
}

/**
 * HTTP status -> a code, for a response that carried no code of its own.
 *
 * Only reached when a proxy, a load balancer or a crash answered instead of husk.
 * Every guess here is signposted with `details.inferredFromStatus` so a caller can
 * tell "the server said this" from "the SDK guessed this".
 */
function codeForStatus(status: number): HuskWireErrorCode {
  if (status === 400 || status === 422) return 'E_SPEC_INVALID';
  if (status === 401 || status === 403) return 'E_NO_CREDENTIALS';
  if (status === 404) return 'E_ROUTE_NOT_FOUND';
  if (status === 413 || status === 429) return 'E_QUOTA';
  if (status === 501) return 'E_NOT_IMPLEMENTED';
  if (status === 503) return 'E_PROVIDER_UNAVAILABLE';
  if (status === 504) return 'E_EXEC_TIMEOUT';
  return 'E_INTERNAL';
}

function isWireErrorBody(v: unknown): v is WireErrorBody {
  return typeof v === 'object' && v !== null && 'error' in v && typeof (v as WireErrorBody).error === 'object';
}

/**
 * Rebuild the `HuskError` the server threw.
 *
 * Three cases, in order of honesty:
 *
 * 1. A code this SDK knows -- round-tripped exactly.
 * 2. A code it does not know (a newer server) -- **still round-tripped exactly**,
 *    and flagged with `details.unrecognizedCode`. Substituting a code we do
 *    recognise would be a plausible-sounding lie, and the caller would branch on
 *    it. The server performs the same widening cast for its own extra codes.
 * 3. No code at all -- inferred from the status, flagged `inferredFromStatus`.
 */
export function errorFromResponse(status: number, body: unknown, url: string): HuskError {
  if (isWireErrorBody(body) && typeof body.error.code === 'string' && body.error.code.length > 0) {
    const { code, message, hint, details } = body.error as { code: string } & WireErrorBody['error'];
    const recognized = isKnownErrorCode(code);
    return new HuskError(code as HuskErrorCode, message ?? `request failed with status ${status}`, {
      hint: hint ?? hintForStatus(status),
      details: { ...details, status, url, ...(recognized ? {} : { unrecognizedCode: true }) },
    });
  }

  if (isWireErrorBody(body)) {
    const { message, hint, details } = body.error;
    return new HuskError(codeForStatus(status) as HuskErrorCode, message ?? `${status} from ${url}`, {
      hint: hint ?? hintForStatus(status),
      details: { ...details, status, url, inferredFromStatus: true },
    });
  }

  const snippet = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body ?? null).slice(0, 200);
  return new HuskError(codeForStatus(status) as HuskErrorCode, `${status} from ${url}`, {
    hint: hintForStatus(status),
    details: { status, url, body: snippet, inferredFromStatus: true },
  });
}

/** The same decode, for an `event: error` frame on an SSE stream. */
export function errorFromEventFrame(payload: unknown, url: string): HuskError {
  if (isWireErrorBody(payload)) {
    const { code, message, hint, details } = payload.error;
    const resolved = typeof code === 'string' && code.length > 0 ? code : 'E_INTERNAL';
    return new HuskError(resolved as HuskErrorCode, message ?? 'the stream failed', {
      hint: hint ?? 'check the control plane logs: `husk serve` prints them on stderr',
      details: {
        ...details,
        url,
        stream: true,
        ...(isKnownErrorCode(resolved) ? {} : { unrecognizedCode: true }),
      },
    });
  }
  return new HuskError('E_INTERNAL', 'the stream failed with a body the SDK did not recognise', {
    hint: 'this is a server bug -- check the `husk serve` logs',
    details: { url, stream: true, body: JSON.stringify(payload ?? null).slice(0, 200) },
  });
}

function hintForStatus(status: number): string {
  if (status === 401 || status === 403) return 'pass a token: new HuskClient({ token }), or HUSK_TOKEN in the environment';
  if (status === 404) return 'check the id or name; `husk ps` lists what exists';
  if (status === 429) return 'the control plane is rate limiting; retry with backoff';
  if (status >= 500) return 'check the control plane logs: `husk serve` prints them on stderr';
  return 'check the request shape against docs/API.md';
}

/** A transport failure: wrong port, no server, DNS, TLS. Never a server response. */
export function transportError(err: unknown, url: string): HuskError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === 'AbortError') {
    return new HuskError('E_ABORTED', `request to ${url} was aborted`, {
      hint: 'the caller aborted the signal, or the client timeout elapsed',
      cause: err,
    });
  }
  return new HuskError('E_INTERNAL', `cannot reach the husk control plane at ${url}: ${message}`, {
    hint: 'start it with `husk serve`, or point the client at the right baseUrl',
    cause: err,
  });
}
