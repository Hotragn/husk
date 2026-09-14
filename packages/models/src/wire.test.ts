import { describe, expect, it } from 'vitest';
import { ToolCallAccumulator, bytes, readLines, readNDJSON, readSSE } from './wire.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('readLines', () => {
  it('joins a line split across chunk boundaries', async () => {
    const lines = await collect(readLines(bytes('hel', 'lo\nwor', 'ld\n')));
    expect(lines).toEqual(['hello', 'world']);
  });

  it('yields a trailing line with no terminator', async () => {
    expect(await collect(readLines(bytes('a\nb')))).toEqual(['a', 'b']);
  });

  it('strips CR from CRLF terminators', async () => {
    expect(await collect(readLines(bytes('a\r\nb\r\n')))).toEqual(['a', 'b']);
  });

  it('does not split a multi-byte character across chunks', async () => {
    const encoded = new TextEncoder().encode('héllo\n');
    const head = encoded.slice(0, 2);
    const tail = encoded.slice(2);
    const source = {
      async *[Symbol.asyncIterator]() {
        yield head;
        yield tail;
      },
    };
    expect(await collect(readLines(source))).toEqual(['héllo']);
  });
});

describe('readSSE — Anthropic frames', () => {
  const ANTHROPIC_STREAM = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":42,"cache_read_input_tokens":8}}}\n',
    '\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');

  it('names each frame and keeps its payload intact', async () => {
    const frames = await collect(readSSE(bytes(ANTHROPIC_STREAM)));
    expect(frames.map((f) => f.event)).toEqual(['message_start', 'content_block_delta', 'message_stop']);
    expect(JSON.parse(frames[0]!.data)).toMatchObject({ message: { usage: { input_tokens: 42 } } });
  });

  it('parses identically when the bytes arrive one character at a time', async () => {
    const whole = await collect(readSSE(bytes(ANTHROPIC_STREAM)));
    const drip = await collect(readSSE(bytes(...ANTHROPIC_STREAM.split(''))));
    expect(drip).toEqual(whole);
  });

  it('ignores comment keep-alives', async () => {
    const frames = await collect(readSSE(bytes(': ping\n\nevent: x\ndata: {"a":1}\n\n')));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('x');
  });
});

describe('readSSE — OpenAI frames', () => {
  const OPENAI_STREAM =
    'data: {"choices":[{"delta":{"content":"He"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
    'data: [DONE]\n\n';

  it('reads unnamed frames', async () => {
    const frames = await collect(readSSE(bytes(OPENAI_STREAM)));
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.event === undefined)).toBe(true);
    expect(frames[2]!.data).toBe('[DONE]');
  });

  it('survives a frame split mid-JSON', async () => {
    const frames = await collect(readSSE(bytes('data: {"choi', 'ces":[{"delta":{"content":"x"}}]}\n\n')));
    expect(JSON.parse(frames[0]!.data)).toMatchObject({ choices: [{ delta: { content: 'x' } }] });
  });

  it('joins multi-line data fields with a newline, per the SSE spec', async () => {
    const frames = await collect(readSSE(bytes('data: line1\ndata: line2\n\n')));
    expect(frames[0]!.data).toBe('line1\nline2');
  });
});

describe('readNDJSON — Ollama', () => {
  const OLLAMA_STREAM =
    '{"model":"gemma3","message":{"role":"assistant","content":"He"},"done":false}\n' +
    '{"model":"gemma3","message":{"role":"assistant","content":"llo"},"done":false}\n' +
    '{"model":"gemma3","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop",' +
    '"prompt_eval_count":11,"eval_count":3}\n';

  it('yields one object per line', async () => {
    const chunks = await collect(readNDJSON<{ done: boolean }>(bytes(OLLAMA_STREAM)));
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toMatchObject({ done: true, prompt_eval_count: 11, eval_count: 3 });
  });

  it('reassembles an object split across chunks', async () => {
    const half = Math.floor(OLLAMA_STREAM.length / 2);
    const chunks = await collect(
      readNDJSON<{ done: boolean }>(bytes(OLLAMA_STREAM.slice(0, half), OLLAMA_STREAM.slice(half))),
    );
    expect(chunks).toHaveLength(3);
  });

  it('drops a truncated final line rather than throwing', async () => {
    const chunks = await collect(readNDJSON(bytes('{"a":1}\n{"b":')));
    expect(chunks).toEqual([{ a: 1 }]);
  });
});

describe('ToolCallAccumulator', () => {
  it('waits for the arguments to become valid JSON', async () => {
    const acc = new ToolCallAccumulator();
    expect(acc.push(0, { id: 'call_1', name: 'read_file' })).toBeUndefined();
    expect(acc.push(0, { argsFragment: '{"pa' })).toBeUndefined();
    expect(acc.push(0, { argsFragment: 'th": "/e' })).toBeUndefined();
    expect(acc.push(0, { argsFragment: 'tc/hosts"' })).toBeUndefined();

    const call = acc.push(0, { argsFragment: '}' });
    expect(call).toEqual({ type: 'tool_call', id: 'call_1', name: 'read_file', args: { path: '/etc/hosts' } });
  });

  it('emits a call exactly once', () => {
    const acc = new ToolCallAccumulator();
    acc.push(0, { id: 'a', name: 'x', argsFragment: '{"k":1}' });
    expect(acc.close(0)).toBeUndefined();
    expect(acc.flush()).toEqual([]);
  });

  it('keeps two interleaved calls apart by index', () => {
    const acc = new ToolCallAccumulator();
    acc.push(0, { id: 'a', name: 'first' });
    acc.push(1, { id: 'b', name: 'second' });
    acc.push(0, { argsFragment: '{"x":' });
    acc.push(1, { argsFragment: '{"y":2}' });
    expect(acc.push(0, { argsFragment: '1}' })).toMatchObject({ id: 'a', args: { x: 1 } });
  });

  it('does not mistake a nested brace for the end of the object', () => {
    const acc = new ToolCallAccumulator();
    acc.push(0, { id: 'a', name: 'x' });
    expect(acc.push(0, { argsFragment: '{"outer": {"inner": 1}' })).toBeUndefined();
    expect(acc.push(0, { argsFragment: '}' })).toMatchObject({ args: { outer: { inner: 1 } } });
  });

  it('does not treat a brace inside a string literal as structure', () => {
    const acc = new ToolCallAccumulator();
    acc.push(0, { id: 'a', name: 'x' });
    expect(acc.push(0, { argsFragment: '{"cmd": "echo }' })).toBeUndefined();
    expect(acc.push(0, { argsFragment: '"}' })).toMatchObject({ args: { cmd: 'echo }' } });
  });

  it('treats a call with no arguments as an empty object', () => {
    const acc = new ToolCallAccumulator();
    acc.push(0, { id: 'a', name: 'now' });
    expect(acc.close(0)).toEqual({ type: 'tool_call', id: 'a', name: 'now', args: {} });
  });

  it('flushes an unterminated call rather than losing it', () => {
    const acc = new ToolCallAccumulator();
    acc.push(0, { id: 'a', name: 'x', argsFragment: '{"broken":' });
    expect(acc.flush()).toEqual([{ type: 'tool_call', id: 'a', name: 'x', args: {} }]);
  });
});
