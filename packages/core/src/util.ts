/** Clamp a string to a byte budget, marking the elision. Keeps head and tail. */
export function clampText(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, 'utf8');
  if (buf.byteLength <= maxBytes) return { text: input, truncated: false };
  const half = Math.max(1, Math.floor((maxBytes - 64) / 2));
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.byteLength - half).toString('utf8');
  const omitted = buf.byteLength - half * 2;
  return { text: `${head}\n... [${omitted} bytes elided by husk] ...\n${tail}`, truncated: true };
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
  /\b(sk-[A-Za-z0-9]{20,})/g,
  /\b(gsk_[A-Za-z0-9]{20,})/g,
  /\b(AIza[0-9A-Za-z_-]{30,})/g,
  /\b(ghp_[A-Za-z0-9]{30,})/g,
  /\b(github_pat_[A-Za-z0-9_]{30,})/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /(-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----)[\s\S]*?(-----END [^-]*-----)/g,
];

export function redact(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => mask(m));
  return out;
}

function mask(s: string): string {
  if (s.includes('PRIVATE KEY')) return '[redacted private key]';
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
