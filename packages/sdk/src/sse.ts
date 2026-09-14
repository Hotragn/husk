import { HuskError } from '@husk-ai/core';
import { errorFromEventFrame } from './errors.js';

/**
 * A minimal server-sent-events reader.
 *
 * Husk only ever sends `event:` and `data:` on a single-line JSON payload, so
 * this deliberately does not implement `id:`, `retry:`, or automatic reconnect.
 * Reconnecting mid-run would silently replay tool calls, which is worse than
 * surfacing the disconnect.
 */
export interface SseFrame {
  event: string;
  data: string;
}

/** Split a UTF-8 byte stream into SSE frames. */
export async function* readFrames(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames end on a blank line. \r\n is legal per the spec and Fastify's
      // reply.raw will emit it on some platforms, so both are accepted.
      let boundary = findBoundary(buffer);
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + boundaryLength(buffer, boundary));
        const frame = parseFrame(raw);
        if (frame) yield frame;
        boundary = findBoundary(buffer);
      }
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

function findBoundary(s: string): number {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function boundaryLength(s: string, at: number): number {
  return s.startsWith('\r\n\r\n', at) ? 4 : 2;
}

export function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split(/\r?\n/);
  let event = 'message';
  const data: string[] = [];
  let sawData = false;
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    // "data: x" and "data:x" are both legal; exactly one leading space is stripped.
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') {
      sawData = true;
      data.push(value);
    }
  }
  // A named frame with no data line at all is still a frame (`event: done` on its
  // own would be one); a heartbeat comment or a blank chunk is not.
  if (!sawData && event === 'message') return null;
  return { event, data: data.join('\n') };
}

/**
 * Decode Husk SSE frames into typed events.
 *
 * Three frame kinds matter, and they are the three `packages/server/src/sse.ts`
 * actually writes:
 *
 * - a normal frame, `data: {...}`, yielded as `T`;
 * - the terminator, `event: done\ndata: {}`, which ends the iterator and is
 *   **not** yielded -- treating it as data is what appended a spurious `{}` to
 *   every stream;
 * - `event: error`, carrying the same `{error:{...}}` body a failed JSON request
 *   would, thrown so `for await` fails exactly like an awaited call.
 *
 * Comment frames (the `: husk stream open` preamble and the 15 s `: ping`
 * heartbeat) are dropped by `parseFrame` before they get here.
 */
export async function* decodeEvents<T>(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  url = '(stream)',
): AsyncGenerator<T> {
  for await (const frame of readFrames(body, signal)) {
    if (frame.event === 'done') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      throw new HuskError('E_INTERNAL', `control plane sent a malformed SSE frame: ${frame.data.slice(0, 120)}`, {
        hint: 'this is a server bug -- check the `husk serve` logs',
      });
    }
    if (frame.event === 'error') throw errorFromEventFrame(parsed, url);
    yield parsed as T;
  }
}
