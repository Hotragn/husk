/**
 * One place where a provider's failure becomes a `HuskError`.
 *
 * Two rules hold everywhere: the error says what to do next, and no API key ever
 * reaches the message. `redact()` catches the well-known key shapes; we additionally
 * scrub the literal secret we were holding, because half the providers in this
 * package mint key formats no pattern list knows about.
 */

import { HuskError, redact, type HuskErrorCode } from '@husk-ai/core';

export const HUSK_UA = 'husk/0.1.0 (+https://github.com/Hotragn/husk)';

export interface ErrorContext {
  provider: string;
  displayName: string;
  model?: string;
  /** Environment variable that supplies this provider's credential, if any. */
  envKey?: string;
  /** The live credential, so it can be scrubbed out of upstream error bodies. */
  secret?: string;
}

/** True when trying the same call again could plausibly succeed. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function scrub(text: string, secret?: string): string {
  let out = text;
  if (secret && secret.length >= 8) out = out.split(secret).join('[redacted api key]');
  return redact(out);
}

/** Trim an upstream error body to something a terminal can show. */
function summarise(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // Not JSON. Providers behind a CDN return HTML on a 502.
  }
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
}

export function httpError(ctx: ErrorContext, status: number, body: string): HuskError {
  const detail = scrub(summarise(body), ctx.secret);
  const where = ctx.model ? `${ctx.displayName} (${ctx.model})` : ctx.displayName;
  const retryable = isRetryableStatus(status);

  let code: HuskErrorCode = 'E_MODEL_ERROR';
  let hint: string;

  if (status === 401 || status === 403) {
    code = 'E_NO_CREDENTIALS';
    hint = ctx.envKey
      ? `${ctx.envKey} is missing or rejected. Re-check the value, or run \`husk doctor\` to see what else is reachable.`
      : `${ctx.displayName} rejected the credential. Run \`husk doctor\`.`;
  } else if (status === 404) {
    code = 'E_MODEL_UNAVAILABLE';
    hint = `${ctx.displayName} does not serve "${ctx.model ?? 'that model'}". Run \`husk models\` to list what it does.`;
  } else if (status === 400 || status === 422) {
    hint = 'The request was rejected as malformed; retrying will not help. Check tool schemas and message ordering.';
  } else if (status === 429) {
    code = 'E_QUOTA';
    hint = `${ctx.displayName} is rate limiting. Husk will back off and fall back; pass \`--model free\` or set \`model: free\` in husk.yaml to avoid it.`;
  } else if (status >= 500) {
    hint = `${ctx.displayName} is having a bad time. Husk will retry, then fall back to the next provider.`;
  } else {
    hint = `Unexpected ${status} from ${ctx.displayName}.`;
  }

  return new HuskError(code, `${where} returned ${status}${detail ? `: ${detail}` : ''}`, {
    hint,
    details: { provider: ctx.provider, status, retryable, model: ctx.model },
  });
}

/** A thrown `fetch` — DNS, TLS, connection reset, or an abort. */
export function networkError(ctx: ErrorContext, cause: unknown): HuskError {
  if (isAbort(cause)) {
    return new HuskError('E_ABORTED', `${ctx.displayName} request aborted`, {
      hint: 'The caller cancelled this request.',
      details: { provider: ctx.provider, retryable: false, model: ctx.model },
      cause,
    });
  }
  const message = scrub(cause instanceof Error ? cause.message : String(cause), ctx.secret);
  return new HuskError('E_MODEL_ERROR', `${ctx.displayName} is unreachable: ${message}`, {
    hint: `Check network access to ${ctx.displayName}. Husk will fall back to another provider if one is configured.`,
    details: { provider: ctx.provider, retryable: true, model: ctx.model },
    cause,
  });
}

export function isAbort(err: unknown): boolean {
  if (err instanceof HuskError) return err.code === 'E_ABORTED';
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
  }
  return false;
}

/** Whether the router should try this failure again, on the same or another model. */
export function isRetryable(err: unknown): boolean {
  if (isAbort(err)) return false;
  if (err instanceof HuskError) {
    const flag = (err.details as { retryable?: unknown } | undefined)?.retryable;
    if (typeof flag === 'boolean') return flag;
    return err.code === 'E_MODEL_ERROR';
  }
  return true;
}

/** Status carried on a normalised error, when there was one. */
export function statusOf(err: unknown): number | undefined {
  if (err instanceof HuskError) {
    const status = (err.details as { status?: unknown } | undefined)?.status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** Reject the whole request rather than shopping it around: it is malformed. */
export function isFatalRequestError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 400 || status === 422;
}

export function jsonHeaders(extra: Record<string, string | undefined>): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': HUSK_UA,
  };
  for (const [k, v] of Object.entries(extra)) if (v) headers[k] = v;
  return headers;
}

export function missingKey(ctx: ErrorContext): HuskError {
  return new HuskError('E_NO_CREDENTIALS', `${ctx.displayName} has no credential configured`, {
    hint: ctx.envKey
      ? `Set ${ctx.envKey}, or run \`ollama pull qwen2.5:7b\` for a free local model that can call tools.`
      : `Configure ${ctx.displayName} first.`,
    details: { provider: ctx.provider, retryable: false },
  });
}
