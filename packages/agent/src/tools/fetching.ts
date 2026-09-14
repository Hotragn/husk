/** Shared plumbing for the tools that talk to the network from the host. */

export interface CappedBody {
  text: string;
  bytes: number;
  truncated: boolean;
}

export async function readCapped(res: Response, maxBytes: number): Promise<CappedBody> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    const buf = Buffer.from(text, 'utf8');
    if (buf.byteLength <= maxBytes) return { text, bytes: buf.byteLength, truncated: false };
    return { text: buf.subarray(0, maxBytes).toString('utf8'), bytes: maxBytes, truncated: true };
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(Buffer.from(value.subarray(0, Math.max(0, remaining))));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: total, truncated };
}

/**
 * One signal that fires on the caller's abort or on our own deadline.
 *
 * `AbortSignal.any` exists on Node 20.3+, but constructing the controller
 * ourselves also gives us the timer handle to clear, so a finished request does
 * not keep the process alive.
 */
export function deadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done(): void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timed out after ${ms}ms`)), ms);
  const forward = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: ac.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

export function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
