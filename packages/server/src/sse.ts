import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorBody } from './errors.js';

export interface SseOptions {
  /** Comment frame interval. Keeps proxies and load balancers from idling us out. */
  heartbeatMs?: number;
  /**
   * Abort the producer when the client has not drained the socket for this long.
   * API.md: "An SSE stream whose client stops reading for 60 s is closed and its run
   * aborted."
   */
  stallTimeoutMs?: number;
}

/**
 * One SSE response.
 *
 * The part that is easy to get wrong is the disconnect. A browser tab closing does
 * not reject the write that follows it, so a naive implementation happily drives an
 * agent -- burning tokens and holding a container -- for a client that left. This
 * wires `close`, `error` and a write-stall timer to a single `AbortController` that
 * the caller passes down into the run.
 */
export class SseStream {
  readonly abort = new AbortController();
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private stall: ReturnType<typeof setTimeout> | undefined;
  private readonly stallTimeoutMs: number;
  private readonly res: FastifyReply['raw'];

  constructor(req: FastifyRequest, reply: FastifyReply, opts: SseOptions = {}) {
    const heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 60_000;
    this.res = reply.raw;

    reply.hijack();
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx buffers text/event-stream by default, which turns a live stream into
      // one delivery at the end. This is the documented opt-out.
      'X-Accel-Buffering': 'no',
    });
    // Nagle would coalesce small event frames into one packet; latency is the point
    // here. Guarded because `inject()` and some proxies hand back a socket stand-in.
    const socket = this.res.socket as { setNoDelay?: (on: boolean) => void } | null;
    if (typeof socket?.setNoDelay === 'function') socket.setNoDelay(true);
    this.res.write(': husk stream open\n\n');

    this.heartbeat = setInterval(() => this.comment('ping'), heartbeatMs);
    this.heartbeat.unref?.();

    // `close` on the *request* also fires on a clean finish in modern Node, so a
    // disconnect is only a disconnect when we have not finished writing. Getting
    // this wrong aborts every stream the instant its body is consumed.
    const bail = (why: string) => () => {
      if (this.res.writableEnded) return;
      this.abandon(why);
    };
    req.raw.on('aborted', bail('client aborted'));
    this.res.on('close', bail('response closed'));
    this.res.on('error', bail('socket error'));
    this.armStall();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /**
   * A client that stops reading leaves us buffering into a full socket. `write`
   * returning false means the kernel buffer is full; if it never drains we treat the
   * client as gone rather than growing the heap.
   */
  private armStall(): void {
    if (this.stall) clearTimeout(this.stall);
    this.stall = setTimeout(() => this.abandon('client stopped reading'), this.stallTimeoutMs);
    this.stall.unref?.();
  }

  private writeRaw(chunk: string): void {
    if (this.closed) return;
    const drained = this.res.write(chunk);
    if (drained) this.armStall();
    else this.res.once('drain', () => this.armStall());
  }

  comment(text: string): void {
    this.writeRaw(`: ${text}\n\n`);
  }

  /** One `data:` line per event, carrying a JSON object. */
  send(data: unknown, event?: string): void {
    if (this.closed) return;
    const payload = JSON.stringify(data);
    this.writeRaw(`${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`);
  }

  /** Errors reach the client in the same `{error:{...}}` shape as a JSON response. */
  sendError(err: unknown): void {
    this.send(errorBody(err), 'error');
  }

  /** Terminating frame from API.md. Safe to call twice. */
  done(): void {
    if (this.closed) return;
    this.writeRaw('event: done\ndata: {}\n\n');
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stall) clearTimeout(this.stall);
    try {
      this.res.end();
    } catch {
      // socket already torn down
    }
  }

  private abandon(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stall) clearTimeout(this.stall);
    if (!this.abort.signal.aborted) this.abort.abort(new Error(`sse: ${reason}`));
    try {
      this.res.destroy();
    } catch {
      // already destroyed
    }
  }
}

/** Drive an async iterable into an SSE response, closing correctly on every path. */
export async function pipeSse<T>(
  stream: SseStream,
  source: (signal: AbortSignal) => AsyncIterable<T>,
  map: (item: T) => { data: unknown; event?: string } = (item) => ({ data: item }),
): Promise<void> {
  try {
    for await (const item of source(stream.signal)) {
      if (stream.isClosed) break;
      const framed = map(item);
      stream.send(framed.data, framed.event);
    }
    stream.done();
  } catch (err) {
    if (stream.signal.aborted) {
      stream.close();
      return;
    }
    stream.sendError(err);
    stream.done();
  }
}
