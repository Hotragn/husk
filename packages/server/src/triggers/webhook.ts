import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Constant-time compare of two hex digests.
 *
 * `a === b` on a signature leaks the length of the shared prefix through timing.
 * That is a real, demonstrated attack on webhook endpoints, and the fix costs a
 * function call.
 */
export function safeCompareHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.trim().toLowerCase(), 'hex');
  const bb = Buffer.from(b.trim().toLowerCase(), 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hmacHex(secret: string, payload: string | Buffer, algorithm = 'sha256'): string {
  return createHmac(algorithm, secret).update(payload).digest('hex');
}

/**
 * Verify a `sha256=<hex>` style signature over the raw request body.
 *
 * The body must be the exact bytes received. Re-serialising parsed JSON changes key
 * order and whitespace, and every signature after that fails for reasons nobody can
 * see in a log.
 */
export function verifyHmacSignature(opts: {
  secret: string;
  rawBody: string | Buffer;
  signature: string | undefined;
  /** Replay window in seconds. Requires `timestamp` and `signedPayload`. */
  toleranceSec?: number;
  timestamp?: string | undefined;
  now?: () => number;
}): SignatureCheck {
  if (!opts.signature) return { ok: false, reason: 'missing signature header' };

  if (opts.toleranceSec !== undefined) {
    if (!opts.timestamp) return { ok: false, reason: 'missing timestamp header' };
    const ts = Number.parseInt(opts.timestamp, 10);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp is not a unix time' };
    const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
    if (Math.abs(nowSec - ts) > opts.toleranceSec) return { ok: false, reason: 'timestamp outside the replay window' };
  }

  const supplied = opts.signature.includes('=') ? opts.signature.slice(opts.signature.indexOf('=') + 1) : opts.signature;
  const payload = opts.timestamp !== undefined ? `${opts.timestamp}.${bodyToString(opts.rawBody)}` : opts.rawBody;
  const expected = hmacHex(opts.secret, payload);
  return safeCompareHex(expected, supplied) ? { ok: true } : { ok: false, reason: 'signature does not match' };
}

function bodyToString(body: string | Buffer): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}
