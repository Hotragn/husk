/** Shared plumbing for the tools that talk to the network from the host. */

import { HuskError } from '@husk-ai/core';

const MAX_REDIRECTS = 10;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** What a hop to another origin must not carry, as browsers do. */
const CREDENTIALS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * `fetch` that follows redirects one hop at a time, and asks `check` about
 * each hop's URL before requesting it. `redirect: 'follow'` would have sent
 * every request in the chain before anything could look: a 302 to an internal
 * address is refused before it is asked, and a public, internal, public chain
 * stops at the second hop. A 303, or a 301 or 302 after a POST, goes on as a
 * GET with no body, as browsers do.
 */
export async function fetchChecked(url: URL, init: RequestInit, check: (url: string) => URL): Promise<{ res: Response; url: URL }> {
  let current = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, method, body, headers, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!REDIRECTS.has(res.status) || !location) return { res, url: current };
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) {
      throw new HuskError('E_TOOL_ERROR', `more than ${MAX_REDIRECTS} redirects from ${url.host}`, { hint: 'the server is redirecting in a loop' });
    }
    const next = check(new URL(location, current).toString());
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
    }
    if (next.origin !== current.origin) {
      headers = new Headers(headers);
      for (const h of CREDENTIALS) headers.delete(h);
    }
    current = next;
  }
}

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
