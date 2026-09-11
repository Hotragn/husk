/**
 * Fixtures for exercising providers without a network.
 *
 * Not exported from `index.ts`: this is test scaffolding, and the chunk boundaries it
 * lets a test choose are the whole point — a stream parser only breaks at boundaries
 * a real network picked and a test never did.
 */

import type { FetchLike } from './providers/openai-compatible.js';

/** A `Response` whose body arrives in exactly these pieces, in this order. */
export function streamResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function errorResponse(status: number, body: unknown = { error: { message: 'nope' } }): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` that records what it was asked and answers from a routing table. */
export function recordingFetch(
  route: (call: RecordedCall) => Response | Promise<Response>,
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    if (init?.signal?.aborted) throw abortError();
    const response = await route(call);
    return response;
  };
  return { fetch: fetchImpl, calls };
}

export function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** A fetch that never answers until the request's signal aborts. */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
