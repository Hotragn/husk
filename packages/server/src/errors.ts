import { HuskError, isHuskError } from '@husk/core';
import type { HuskErrorCode } from '@husk/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Codes the API needs that `HuskErrorCode` does not yet carry.
 *
 * API.md maps `E_*_NOT_FOUND` -> 404 as a family, but core only declares
 * `E_COMPUTER_NOT_FOUND`. Rather than return a computer error for a missing husk,
 * the server declares the rest here and casts in exactly one place. These belong in
 * `@husk/core`; see the note in README.md.
 */
export const SERVER_ERROR_CODES = [
  'E_HUSK_NOT_FOUND',
  'E_RUN_NOT_FOUND',
  'E_APPROVAL_NOT_FOUND',
  'E_TRANSCRIPT_NOT_FOUND',
  'E_ROUTE_NOT_FOUND',
] as const;

export type ServerErrorCode = HuskErrorCode | (typeof SERVER_ERROR_CODES)[number];

/** The one place a server-local code is widened into `HuskError`. */
export function huskError(
  code: ServerErrorCode,
  message: string,
  opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
): HuskError {
  return new HuskError(code as HuskErrorCode, message, opts);
}

/** The wire shape every failing response takes. API.md, "Conventions". */
export interface ErrorBody {
  error: { code: ServerErrorCode; message: string; hint?: string; details?: Record<string, unknown> };
}

/**
 * Codes whose `details` are safe and useful to a client.
 *
 * Withheld by default: `details` is where we put stderr, resolved paths and raw
 * parser output, none of which belongs in an HTTP response. But a policy denial
 * carries `{host, mode, internal}`, and without `internal` a UI cannot tell
 * "not in your allow-list" from "blocked by the built-in loopback rule" -- two
 * refusals that need different copy and different fixes.
 */
const DETAILS_SAFE: ReadonlySet<string> = new Set(['E_EXEC_DENIED', 'E_FS_DENIED', 'E_SPEC_INVALID', 'E_QUOTA']);

const EXPLICIT: Partial<Record<ServerErrorCode, number>> = {
  E_SPEC_INVALID: 422,
  E_QUOTA: 429,
  E_BUDGET_EXCEEDED: 429,
  E_NO_CREDENTIALS: 401,
  E_PROVIDER_UNAVAILABLE: 503,
  E_MODEL_UNAVAILABLE: 503,
  E_EXEC_TIMEOUT: 504,
  E_NOT_IMPLEMENTED: 501,
};

/**
 * Map an error code onto a status.
 *
 * The suffix rules from API.md are applied as rules rather than as a hand-written
 * table, so a new `E_<thing>_NOT_FOUND` added to core lands on 404 without anyone
 * remembering to edit this file.
 */
export function statusForCode(code: ServerErrorCode): number {
  const explicit = EXPLICIT[code];
  if (explicit !== undefined) return explicit;
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code.endsWith('_DENIED')) return 403;
  return 500;
}

export function errorBody(err: unknown): ErrorBody {
  if (isHuskError(err)) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    if (err.hint) body.error.hint = err.hint;
    if (err.details && DETAILS_SAFE.has(err.code)) body.error.details = err.details;
    return body;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: 'E_INTERNAL', message, hint: 'this is a bug in husk -- please report it' } };
}

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const body = errorBody(err);
  return reply.code(statusForCode(body.error.code)).send(body);
}

/**
 * Fastify allows exactly one not-found handler per encapsulation scope, so the
 * console's single-page-app fallback cannot register its own -- it hands us this
 * instead, and we consult it before giving up on a request.
 */
export type NotFoundFallback = (req: FastifyRequest, reply: FastifyReply) => boolean | Promise<boolean>;

let notFoundFallback: NotFoundFallback | undefined;

export function setNotFoundFallback(fn: NotFoundFallback | undefined): void {
  notFoundFallback = fn;
}

/** 404, body-parse failures and every thrown error funnel through the same shape. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    if (notFoundFallback && (await notFoundFallback(req, reply))) return reply;
    return sendError(
      reply,
      huskError('E_ROUTE_NOT_FOUND', `no route for ${req.method} ${req.url}`, {
        hint: 'see docs/API.md for the endpoints this server serves',
      }),
    );
  });

  app.setErrorHandler((raw: unknown, req, reply) => {
    const err = raw as Error & { statusCode?: number };
    if (isHuskError(err)) {
      req.log.debug({ code: err.code }, err.message);
      void sendError(reply, err);
      return;
    }
    // Fastify's own validation and body-parsing failures arrive as plain errors
    // carrying a statusCode. Preserve the status, normalise the body.
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    const code: ServerErrorCode =
      status === 413
        ? 'E_QUOTA'
        : status === 400 || status === 422
          ? 'E_SPEC_INVALID'
          : status === 401
            ? 'E_NO_CREDENTIALS'
            : 'E_INTERNAL';
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    const body: ErrorBody = { error: { code, message: err.message } };
    if (status === 413) body.error.hint = 'request bodies cap at 32 MB';
    void reply.code(status).send(body);
  });
}

type Missing = 'computer' | 'husk' | 'run' | 'approval' | 'transcript';

// These name real commands and real endpoints. A hint that sends someone to
// `husk ls` -- which does not exist -- costs more trust than no hint at all.
const MISSING_HINTS: Record<Missing, string> = {
  computer: 'run `husk ps` to list computers',
  husk: 'list them with `GET /v1/husks`, or look in ~/.husk/husks',
  run: 'list recent runs with `GET /v1/runs`',
  approval: 'approvals expire 120s after they are raised',
  transcript: 'import it again with `husk import`',
};

export function notFound(kind: Missing, ref: string): HuskError {
  return huskError(`E_${kind.toUpperCase()}_NOT_FOUND` as ServerErrorCode, `no ${kind} with id ${ref}`, {
    hint: MISSING_HINTS[kind],
  });
}

export function invalidSpec(issues: string[]): HuskError {
  return huskError('E_SPEC_INVALID', `husk spec is not valid:\n  ${issues.join('\n  ')}`, {
    hint: 'POST /v1/husks/validate returns the same issue list without saving anything',
    details: { issues },
  });
}
