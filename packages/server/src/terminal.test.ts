import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

/**
 * The terminal socket, exercised over a real listening port.
 *
 * `app.inject()` cannot upgrade a connection, so none of the other server tests
 * reach this route -- which is exactly how it shipped with a bug where the
 * `message` listener was attached after an `await`. A human typing into the
 * console never noticed; every programmatic client lost its first command.
 */

let harness: TestApp;
let socket: WebSocket | undefined;

afterEach(async () => {
  socket?.close();
  socket = undefined;
  await harness?.cleanup();
});

interface Frame {
  type: string;
  [k: string]: unknown;
}

/** Collect frames until `exit` (or `error`), so a test never hangs on a silent socket. */
function collect(ws: WebSocket, timeoutMs = 20_000): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const timer = setTimeout(
      () => reject(new Error(`no exit frame within ${timeoutMs}ms; got ${JSON.stringify(frames)}`)),
      timeoutMs,
    );
    ws.on('message', (raw) => {
      let f: Frame;
      try {
        f = JSON.parse(raw.toString()) as Frame;
      } catch {
        return;
      }
      frames.push(f);
      if (f.type === 'exit' || f.type === 'error') {
        clearTimeout(timer);
        resolve(frames);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function listen(): Promise<{ port: number; id: string }> {
  harness = await buildTestApp();
  await harness.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = harness.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind a port');

  const created = await harness.app.inject({
    method: 'POST',
    url: '/v1/computers',
    payload: { provider: 'local' },
  });
  expect(created.statusCode).toBe(201);
  return { port: addr.port, id: created.json().id as string };
}

describe('WS /v1/computers/:id/terminal', () => {
  it('runs a command sent immediately on open, before the ready frame', async () => {
    const { port, id } = await listen();
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/computers/${id}/terminal`);
    const frames = collect(socket);

    // The regression: send the instant the socket opens, giving the server no
    // chance to finish resolving the computer first.
    await new Promise<void>((r) => socket!.on('open', () => r()));
    socket.send('echo husk-ws-regression');

    const got = await frames;
    expect(got.map((f) => f.type)).toContain('ready');
    expect(got.find((f) => f.type === 'exit')).toMatchObject({ exitCode: 0 });
    const out = got
      .filter((f) => f.type === 'stdout')
      .map((f) => String(f.data))
      .join('');
    expect(out).toContain('husk-ws-regression');
  });

  it('preserves the order of commands queued before the computer resolves', async () => {
    const { port, id } = await listen();
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/computers/${id}/terminal`);

    const exits: Frame[] = [];
    const out: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`only ${exits.length} exits: ${out.join('|')}`)), 30_000);
      socket!.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as Frame;
        if (f.type === 'stdout') out.push(String(f.data));
        if (f.type === 'error') {
          clearTimeout(timer);
          reject(new Error(String(f.error)));
        }
        if (f.type === 'exit') {
          exits.push(f);
          if (exits.length === 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      socket!.on('error', reject);
    });

    await new Promise<void>((r) => socket!.on('open', () => r()));
    socket.send('echo first');
    socket.send('echo second');

    await done;
    const joined = out.join('');
    expect(joined.indexOf('first')).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf('second')).toBeGreaterThan(joined.indexOf('first'));
  });

  it('ignores a resize frame instead of running it as a command', async () => {
    const { port, id } = await listen();
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/computers/${id}/terminal`);
    const frames = collect(socket);

    await new Promise<void>((r) => socket!.on('open', () => r()));
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    socket.send('echo after-resize');

    const got = await frames;
    // Exactly one command ran: the resize must not have been executed as text.
    expect(got.filter((f) => f.type === 'exit')).toHaveLength(1);
    const out = got
      .filter((f) => f.type === 'stdout')
      .map((f) => String(f.data))
      .join('');
    expect(out).toContain('after-resize');
    // The control frame itself must never reach a shell.
    expect(out).not.toContain('"type"');
    expect(out).not.toContain('cols');
  });

  it('closes with an error frame when the computer does not exist', async () => {
    const { port } = await listen();
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/computers/cmp_nope/terminal`);
    const frames = collect(socket);
    const got = await frames;
    expect(got[0]).toMatchObject({ type: 'error' });
  });
});
