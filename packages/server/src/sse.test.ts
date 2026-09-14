import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { SseStream, pipeSse } from './sse.js';

/**
 * A response double that records the exact bytes written.
 *
 * SSE is a wire format and the framing is the contract: a missing blank line, a
 * `data:` split across two writes, a stray newline inside a payload, and the
 * client's parser silently drops the event.
 */
class FakeRes extends EventEmitter {
  chunks: string[] = [];
  head: { status?: number; headers?: Record<string, string> } = {};
  writableEnded = false;
  ended = false;
  destroyed = false;
  socket: { setNoDelay(on: boolean): void } | null = { setNoDelay: () => undefined };
  private drains = true;

  writeHead(status: number, headers: Record<string, string>): this {
    this.head = { status, headers };
    return this;
  }

  write(chunk: string): boolean {
    if (this.ended) throw new Error('write after end');
    this.chunks.push(chunk);
    return this.drains;
  }

  end(): void {
    this.ended = true;
    this.writableEnded = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  stopDraining(): void {
    this.drains = false;
  }

  get text(): string {
    return this.chunks.join('');
  }

  /** Frames as a client's parser would see them. */
  get frames(): string[] {
    return this.text.split('\n\n').filter((f) => f.length > 0);
  }

  get dataEvents(): unknown[] {
    return this.frames
      .filter((f) => f.includes('data: '))
      .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 'data: '.length)));
  }
}

function harness(opts: { heartbeatMs?: number; stallTimeoutMs?: number } = {}) {
  const res = new FakeRes();
  const req = new EventEmitter();
  const reply = { hijack: vi.fn(), raw: res } as unknown as FastifyReply;
  const stream = new SseStream({ raw: req } as unknown as FastifyRequest, reply, opts);
  return { res, req, stream, reply };
}

describe('SseStream framing', () => {
  it('writes the headers the protocol and the proxies both need', () => {
    const { res, stream } = harness();
    expect(res.head.status).toBe(200);
    expect(res.head.headers?.['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(res.head.headers?.['Cache-Control']).toContain('no-cache');
    // Without this, nginx buffers the whole stream and delivers it at the end.
    expect(res.head.headers?.['X-Accel-Buffering']).toBe('no');
    stream.close();
  });

  it('opens with a comment so the client sees bytes immediately', () => {
    const { res, stream } = harness();
    expect(res.chunks[0]).toBe(': husk stream open\n\n');
    stream.close();
  });

  it('frames one json object per data line, terminated by a blank line', () => {
    const { res, stream } = harness();
    stream.send({ type: 'text_delta', text: 'hello' });
    stream.send({ type: 'text_delta', text: 'world' });
    expect(res.chunks.slice(1)).toEqual([
      'data: {"type":"text_delta","text":"hello"}\n\n',
      'data: {"type":"text_delta","text":"world"}\n\n',
    ]);
    stream.close();
  });

  it('keeps a multi-line payload on one data line', () => {
    const { res, stream } = harness();
    stream.send({ text: 'line one\nline two' });
    // A raw newline would split the frame; JSON escapes it, which is why the
    // payload is always serialised rather than interpolated.
    expect(res.chunks[1]).toBe('data: {"text":"line one\\nline two"}\n\n');
    expect(res.frames).toHaveLength(2);
    stream.close();
  });

  it('prefixes an event name when one is given', () => {
    const { res, stream } = harness();
    stream.send({ ok: true }, 'progress');
    expect(res.chunks[1]).toBe('event: progress\ndata: {"ok":true}\n\n');
    stream.close();
  });

  it('terminates with event: done', () => {
    const { res, stream } = harness();
    stream.send({ a: 1 });
    stream.done();
    expect(res.text.endsWith('event: done\ndata: {}\n\n')).toBe(true);
    expect(res.ended).toBe(true);
  });

  it('is idempotent on done and close', () => {
    const { res, stream } = harness();
    stream.done();
    stream.done();
    stream.close();
    expect(res.text.match(/event: done/g)).toHaveLength(1);
  });

  it('drops writes after close instead of throwing', () => {
    const { res, stream } = harness();
    stream.close();
    stream.send({ late: true });
    expect(res.text).not.toContain('late');
  });

  it('sends an error in the same shape as a json response', () => {
    const { res, stream } = harness();
    stream.sendError(new Error('boom'));
    const frame = res.frames[1]!;
    expect(frame.startsWith('event: error\n')).toBe(true);
    const body = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: 'E_INTERNAL', message: 'boom' });
    stream.close();
  });

  it('emits heartbeat comments on an interval', async () => {
    vi.useFakeTimers();
    try {
      const { res, stream } = harness({ heartbeatMs: 15_000 });
      vi.advanceTimersByTime(45_000);
      expect(res.chunks.filter((c) => c === ': ping\n\n')).toHaveLength(3);
      stream.close();
      vi.advanceTimersByTime(30_000);
      expect(res.chunks.filter((c) => c === ': ping\n\n')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SseStream disconnect handling', () => {
  it('aborts the producer when the response closes early', () => {
    const { res, stream } = harness();
    expect(stream.signal.aborted).toBe(false);
    res.emit('close');
    expect(stream.signal.aborted).toBe(true);
    expect(stream.isClosed).toBe(true);
    expect(res.destroyed).toBe(true);
  });

  it('does not abort when the response closes after a clean end', () => {
    const { res, stream } = harness();
    stream.done();
    res.emit('close');
    expect(stream.signal.aborted).toBe(false);
  });

  it('aborts on a client abort', () => {
    const { req, stream } = harness();
    req.emit('aborted');
    expect(stream.signal.aborted).toBe(true);
  });

  it('aborts a client that stops reading', () => {
    vi.useFakeTimers();
    try {
      const { res, stream } = harness({ stallTimeoutMs: 60_000 });
      res.stopDraining();
      stream.send({ a: 1 });
      vi.advanceTimersByTime(61_000);
      expect(stream.signal.aborted).toBe(true);
      expect(stream.signal.reason).toMatchObject({ message: expect.stringContaining('stopped reading') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms the stall timer while the client keeps up', () => {
    vi.useFakeTimers();
    try {
      const { stream } = harness({ stallTimeoutMs: 10_000 });
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(9_000);
        stream.send({ i });
      }
      vi.advanceTimersByTime(9_000);
      expect(stream.signal.aborted).toBe(false);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pipeSse', () => {
  it('pumps an iterable and terminates it', async () => {
    const { res, stream } = harness();
    await pipeSse(stream, async function* () {
      yield { type: 'a' };
      yield { type: 'b' };
    });
    expect(res.dataEvents).toEqual([{ type: 'a' }, { type: 'b' }, {}]);
    expect(res.text).toContain('event: done');
  });

  it('passes the abort signal to the producer and stops on disconnect', async () => {
    const { res, stream } = harness();
    let sawAbort = false;

    const pumped = pipeSse(stream, async function* (signal) {
      yield { n: 1 };
      // The client leaves here.
      res.emit('close');
      await new Promise((r) => setTimeout(r, 5));
      sawAbort = signal.aborted;
      yield { n: 2 };
    });

    await pumped;
    expect(sawAbort).toBe(true);
    // Nothing after the disconnect reached the wire.
    expect(res.text).not.toContain('"n":2');
    expect(res.text).not.toContain('event: done');
  });

  it('reports a producer error as an error frame followed by done', async () => {
    const { res, stream } = harness();
    await pipeSse(stream, async function* () {
      yield { ok: 1 };
      throw new Error('producer exploded');
    });
    expect(res.text).toContain('event: error');
    expect(res.text).toContain('producer exploded');
    expect(res.text).toContain('event: done');
  });

  it('applies the frame mapper', async () => {
    const { res, stream } = harness();
    await pipeSse(
      stream,
      async function* () {
        yield 'hi';
      },
      (item) => ({ data: { text: item }, event: 'chunk' }),
    );
    expect(res.text).toContain('event: chunk\ndata: {"text":"hi"}');
  });
});
