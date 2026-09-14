import { describe, expect, it } from 'vitest';
import { HuskError } from '@husk-ai/core';
import { decodeEvents, parseFrame, readFrames } from './sse.js';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('parseFrame', () => {
  it('strips exactly one leading space after the colon', () => {
    expect(parseFrame('data: {"a":1}')).toEqual({ event: 'message', data: '{"a":1}' });
    expect(parseFrame('data:{"a":1}')).toEqual({ event: 'message', data: '{"a":1}' });
    expect(parseFrame('data:  x')).toEqual({ event: 'message', data: ' x' });
  });

  it('reads the event name', () => {
    expect(parseFrame('event: error\ndata: {}')).toEqual({ event: 'error', data: '{}' });
  });

  it('joins multi-line data with newlines', () => {
    expect(parseFrame('data: a\ndata: b')).toEqual({ event: 'message', data: 'a\nb' });
  });

  it('ignores comments and empty frames', () => {
    expect(parseFrame(': keepalive')).toBeNull();
    expect(parseFrame('')).toBeNull();
  });
});

describe('readFrames', () => {
  it('splits on a blank line', async () => {
    const frames = await collect(readFrames(streamOf('data: 1\n\ndata: 2\n\n')));
    expect(frames.map((f) => f.data)).toEqual(['1', '2']);
  });

  it('handles CRLF boundaries', async () => {
    const frames = await collect(readFrames(streamOf('data: 1\r\n\r\ndata: 2\r\n\r\n')));
    expect(frames.map((f) => f.data)).toEqual(['1', '2']);
  });

  it('reassembles a frame split across chunks', async () => {
    const frames = await collect(readFrames(streamOf('data: {"ty', 'pe":"x"}', '\n\n')));
    expect(frames.map((f) => f.data)).toEqual(['{"type":"x"}']);
  });

  it('yields a trailing frame that never got its blank line', async () => {
    const frames = await collect(readFrames(streamOf('data: last')));
    expect(frames.map((f) => f.data)).toEqual(['last']);
  });
});

describe('decodeEvents', () => {
  it('yields typed events', async () => {
    const events = await collect(
      decodeEvents<{ type: string }>(streamOf('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n')),
    );
    expect(events).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  /**
   * The terminator the server writes is `event: done\ndata: {}` -- see
   * `SseStream.done()`. Yielding its `{}` payload appended a phantom empty event
   * to every stream this SDK read.
   */
  it('ends at the done frame without yielding its empty payload', async () => {
    const events = await collect(
      decodeEvents<{ type: string }>(
        streamOf('data: {"type":"a"}\n\nevent: done\ndata: {}\n\ndata: {"type":"b"}\n\n'),
      ),
    );
    expect(events).toEqual([{ type: 'a' }]);
  });

  it('drops the stream preamble and the heartbeat comments', async () => {
    const events = await collect(
      decodeEvents<{ type: string }>(
        streamOf(': husk stream open\n\n', 'data: {"type":"a"}\n\n', ': ping\n\n', 'event: done\ndata: {}\n\n'),
      ),
    );
    expect(events).toEqual([{ type: 'a' }]);
  });

  it('throws a HuskError carrying the server code and hint on an error frame', async () => {
    const it = decodeEvents(streamOf('event: error\ndata: {"error":{"code":"E_QUOTA","message":"too many","hint":"rm one"}}\n\n'));
    await expect(collect(it)).rejects.toMatchObject({
      name: 'HuskError',
      code: 'E_QUOTA',
      message: 'too many',
      hint: 'rm one',
    });
  });

  it('round-trips a server-only code out of an error frame', async () => {
    const it = decodeEvents(streamOf('event: error\ndata: {"error":{"code":"E_RUN_NOT_FOUND","message":"gone"}}\n\n'));
    await expect(collect(it)).rejects.toMatchObject({ code: 'E_RUN_NOT_FOUND' });
  });

  it('reports malformed JSON as a server bug rather than crashing', async () => {
    await expect(collect(decodeEvents(streamOf('data: {not json\n\n')))).rejects.toBeInstanceOf(HuskError);
  });
});
