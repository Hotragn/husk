import { Buffer } from 'node:buffer';

/**
 * Where a UTF-8 character actually starts, at or before `i`.
 *
 * Slicing a byte buffer at an arbitrary offset lands in the middle of a
 * multi-byte character about as often as not, and `toString('utf8')` renders
 * the orphaned halves as U+FFFD. Cutting a 200 KB log used to leave a few of
 * those at each seam -- rare enough to look like the program's own output was
 * corrupt rather than like husk's scissors, which is the worse failure.
 */
export function startOfChar(buf: Buffer, i: number): number {
  let at = i;
  // Continuation bytes are 10xxxxxx. Walk back to the lead byte. Four is the
  // longest a legal sequence gets, so a bounded walk cannot loop on bad input.
  for (let steps = 0; at > 0 && steps < 4 && (buf[at]! & 0xc0) === 0x80; steps++) at--;
  return at;
}

/** The end of the last whole character at or before `i`. */
export function endOfChar(buf: Buffer, i: number): number {
  if (i >= buf.byteLength) return buf.byteLength;
  return startOfChar(buf, i);
}

/**
 * The length of the buffer with any trailing *incomplete* character removed.
 *
 * Distinct from {@link endOfChar}, which answers "where is the boundary at or
 * before offset i". Here the offset is the end of the buffer, and the question
 * is whether the last character finished -- a lead byte announces its own
 * length, so a sequence that runs off the end is detectable.
 */
export function completeCharEnd(buf: Buffer): number {
  const start = startOfChar(buf, buf.byteLength - 1);
  if (start < 0) return 0;
  const lead = buf[start]!;
  const len = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return start + len <= buf.byteLength ? buf.byteLength : start;
}

/**
 * The next character boundary at or after `i`.
 *
 * Used for the *start* of a kept tail, where {@link startOfChar} would be
 * wrong: rounding backwards keeps more bytes than the budget allowed, which is
 * how a cap of 38 came back as 39.
 */
export function nextCharBoundary(buf: Buffer, i: number): number {
  let at = Math.max(0, i);
  while (at < buf.byteLength && (buf[at]! & 0xc0) === 0x80) at++;
  return at;
}

/**
 * Cut oversized text down to `maxBytes`, keeping both ends.
 *
 * The middle is where a long log is least interesting -- the command line and
 * the first errors are at the top, the failure and the exit are at the bottom.
 * What is dropped is always said, inline, in bytes.
 *
 * Two things it now gets right that it did not: the seams land on character
 * boundaries, and the result honours the cap. The marker and newlines are
 * counted against the budget rather than added on top, so `clampText(s, 10)`
 * no longer returns 38 bytes -- a cap the caller chose for a token budget was
 * being exceeded by the very code enforcing it.
 */
export function clampText(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, 'utf8');
  const marker = (omitted: number) => `\n... [${omitted} bytes elided by husk] ...\n`;
  if (buf.byteLength <= maxBytes) return { text: input, truncated: false };

  // The marker's own length depends on the number printed inside it, which
  // depends on how much we keep. Budgeting against the largest that number can
  // be -- the whole input -- settles it in one pass and can only leave slack.
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker(buf.byteLength)));
  const half = Math.floor(budget / 2);

  if (half < 1) {
    // No room for both ends plus an honest marker. Say what happened and keep
    // nothing rather than emit something longer than the cap we were given.
    const text = marker(buf.byteLength).trim();
    return { text: Buffer.byteLength(text) <= maxBytes ? text : '', truncated: true };
  }

  const headEnd = endOfChar(buf, half);
  const tailStart = nextCharBoundary(buf, buf.byteLength - half);
  const head = buf.subarray(0, headEnd).toString('utf8');
  const tail = buf.subarray(tailStart).toString('utf8');
  const omitted = tailStart - headEnd;
  return { text: `${head}${marker(omitted)}${tail}`, truncated: true };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** Exponential backoff with full jitter. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 250;
  const max = opts.maxMs ?? 8000;
  let lastErr: unknown;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await fn(a);
    } catch (err) {
      lastErr = err;
      if (a === attempts) break;
      if (opts.shouldRetry && !opts.shouldRetry(err, a)) break;
      const ceiling = Math.min(max, base * 2 ** (a - 1));
      const delay = Math.floor(Math.random() * ceiling);
      opts.onRetry?.(err, a, delay);
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

/** Race a promise against a timeout without leaking the timer. */
export async function withTimeout<T>(p: Promise<T>, ms: number, message = 'timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Anything that looks like a credential, before it reaches a log or a model. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-ant-[A-Za-z0-9_-]{20,})/g,
  // The class must include `-` and `_`: OpenAI project keys are `sk-proj-...`,
  // and [A-Za-z0-9] stops at the second dash, leaving 7 characters that never
  // reach the 20-char minimum. Measured: a full sk-proj- key passed through
  // redact() completely untouched.
  /\b(sk-[A-Za-z0-9_-]{20,})/g,
  /\b(gsk_[A-Za-z0-9]{20,})/g,
  /\b(AIza[0-9A-Za-z_-]{30,})/g,
  /\b(ghp_[A-Za-z0-9]{30,})/g,
  /\b(github_pat_[A-Za-z0-9_]{30,})/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(npm_[A-Za-z0-9]{30,})/g,
  /\b(fo1_[A-Za-z0-9_-]{20,})/g,
  /\b(xai-[A-Za-z0-9]{20,})/g,
  // A bearer token has no prefix of its own -- the only thing marking it is
  // the header it arrives in. Without this, any provider husk has no pattern
  // for leaks in full the moment a request is logged or an error echoes its
  // headers back.
  /((?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /(-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----)[\s\S]*?(-----END [^-]*-----)/g,
];

export function redact(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => mask(m));
  return out;
}

function mask(s: string): string {
  if (s.includes('PRIVATE KEY')) return '[redacted private key]';

  // For a header match the name and scheme are not the secret, and keeping
  // them is the difference between "Authorization: Bearer [redacted]" and a
  // bare "[redacted]" that leaves a reader guessing which header leaked.
  const header = /^((?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|Token)\s+)/i.exec(s);
  if (header) return `${header[1]}[redacted]`;
  const keep = Math.min(6, Math.floor(s.length / 4));
  return `${s.slice(0, keep)}...[redacted]`;
}

/** Approximate token count. Good enough for budgeting; never for billing. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

/** Bounded-concurrency map that preserves input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
