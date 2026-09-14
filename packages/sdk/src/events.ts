import { HuskError } from '@husk-ai/core';
import type { Http } from './http.js';
import type { EventTopic, HuskEventFrame } from './types.js';

export interface EventStreamOptions {
  /**
   * Filter to these topics.
   *
   * Sending a filter also makes the server replay the matching backlog, so a
   * console that reconnects does not start with an empty screen.
   */
  topics?: EventTopic[];
  signal?: AbortSignal;
}

/**
 * A live connection to `WS /v1/events`.
 *
 * Iterate it with `for await`. It ends when the socket closes -- cleanly on
 * `close()` or an aborted signal, and by throwing on a transport failure. There
 * is no reconnect, for the same reason the SSE reader has none.
 */
export interface HuskEventStream extends AsyncIterable<HuskEventFrame> {
  /** Resolves when the socket is open, rejects if it never opens. */
  opened(): Promise<void>;
  /** Re-filter. Pass nothing to receive every topic again. */
  subscribe(topics?: EventTopic[]): void;
  /** Round-trip probe; the server answers `{ type: 'pong' }`. */
  ping(): void;
  close(): void;
}

const OPEN = 1;

/** Whatever the runtime handed us for `MessageEvent.data`, as text. */
function asText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return String(data);
}

export function openEventStream(http: Http, opts: EventStreamOptions = {}): HuskEventStream {
  const Ctor = http.webSocketCtor();
  const url = http.wsUrl('/v1/events');
  const socket = new Ctor(url);

  const queue: HuskEventFrame[] = [];
  const waiters: Array<{
    resolve: (r: IteratorResult<HuskEventFrame>) => void;
    reject: (e: unknown) => void;
  }> = [];
  const openWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  let done = false;
  let failure: HuskError | undefined;
  let isOpen = false;

  const settleOpen = (err?: HuskError) => {
    for (const w of openWaiters.splice(0)) {
      if (err) w.reject(err);
      else w.resolve();
    }
  };

  const finish = (err?: HuskError) => {
    if (done) return;
    done = true;
    failure = err;
    settleOpen(err);
    for (const w of waiters.splice(0)) {
      if (err) w.reject(err);
      else w.resolve({ value: undefined, done: true });
    }
  };

  const push = (frame: HuskEventFrame) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ value: frame, done: false });
    else queue.push(frame);
  };

  const send = (msg: unknown) => {
    if (socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(msg));
  };

  socket.addEventListener('open', (() => {
    isOpen = true;
    settleOpen();
    if (opts.topics) send({ type: 'subscribe', topics: opts.topics });
  }) as never);

  socket.addEventListener('message', ((ev: { data: unknown }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(asText(ev.data));
    } catch {
      finish(
        new HuskError('E_INTERNAL', 'the event socket sent a frame that is not JSON', {
          hint: 'this is a server bug -- check the `husk serve` logs',
        }),
      );
      return;
    }
    push(parsed as HuskEventFrame);
  }) as never);

  socket.addEventListener('error', (() => {
    // A socket that never opened is a connection failure and should throw; one
    // that errors after close has nothing left to tell the caller.
    if (!isOpen) {
      finish(
        new HuskError('E_INTERNAL', `cannot open the husk event socket at ${url}`, {
          hint: 'start it with `husk serve`, or check the token if HUSK_TOKEN is set on the server',
        }),
      );
    }
  }) as never);

  socket.addEventListener('close', (() => finish()) as never);

  const onAbort = () => {
    try {
      socket.close(1000, 'client aborted');
    } catch {
      // already gone
    }
    finish();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const iterator: AsyncIterator<HuskEventFrame> = {
    next(): Promise<IteratorResult<HuskEventFrame>> {
      const buffered = queue.shift();
      if (buffered) return Promise.resolve({ value: buffered, done: false });
      if (failure) return Promise.reject(failure);
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    return(): Promise<IteratorResult<HuskEventFrame>> {
      try {
        socket.close(1000, 'iteration stopped');
      } catch {
        // already gone
      }
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  return {
    [Symbol.asyncIterator]: () => iterator,
    opened(): Promise<void> {
      if (isOpen) return Promise.resolve();
      if (failure) return Promise.reject(failure);
      if (done) {
        return Promise.reject(
          new HuskError('E_INTERNAL', 'the husk event socket closed before it opened', {
            hint: 'check that the control plane is running and the token is right',
          }),
        );
      }
      return new Promise((resolve, reject) => openWaiters.push({ resolve, reject }));
    },
    subscribe(topics?: EventTopic[]): void {
      send({ type: 'subscribe', ...(topics ? { topics } : {}) });
    },
    ping(): void {
      send({ type: 'ping' });
    },
    close(): void {
      try {
        socket.close(1000, 'client closed');
      } catch {
        // already gone
      }
      finish();
    },
  };
}
