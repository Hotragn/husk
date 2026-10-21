import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `driver.py --serve` against a fake Chromium: a loopback HTTP server that
 * answers /json/version and speaks just enough websocket and CDP to answer
 * what the driver asks. This is the one place the long-lived driver -- its
 * request loop, its cached sessions, its actions and its screencast acks --
 * runs for real without a browser.
 */

const here = dirname(fileURLToPath(import.meta.url));
const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['-c', 'pass']).status === 0);

type Cdp = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

interface FakeChromium {
  port: number;
  received: Cdp[];
  connections: number;
  acks: number[];
  close(): Promise<void>;
}

function frame(payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.alloc(10);
  if (n >= 65536) {
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

async function fakeChromium(frames = 4): Promise<FakeChromium> {
  const fake = { received: [] as Cdp[], connections: 0, acks: [] as number[] } as FakeChromium;
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ Browser: 'Fake/1', webSocketDebuggerUrl: `ws://127.0.0.1:${fake.port}/devtools/browser/x` }));
  });
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket);
    fake.connections++;
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (obj: unknown) => socket.write(frame(Buffer.from(JSON.stringify(obj))));
    let sent = 0;
    const castFrame = () => {
      if (sent >= frames) return;
      sent++;
      send({ method: 'Page.screencastFrame', sessionId: 'S1', params: { data: `F${sent}`, sessionId: sent, metadata: { deviceWidth: 800, deviceHeight: 600 } } });
    };
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        let len = buf[1]! & 0x7f;
        let at = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          at = 10;
        }
        if (buf.length < at + 4 + len) return;
        const mask = buf.subarray(at, at + 4);
        const body = Buffer.from(buf.subarray(at + 4, at + 4 + len));
        for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
        const opcode = buf[0]! & 0x0f;
        buf = buf.subarray(at + 4 + len);
        if (opcode !== 1) continue;
        const msg = JSON.parse(body.toString('utf8')) as Cdp;
        fake.received.push(msg);
        const reply = (result: unknown) => send({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), result });
        switch (msg.method) {
          case 'Target.attachToTarget':
            reply({ sessionId: 'S1' });
            break;
          case 'Page.navigate':
            reply({ frameId: 'F' });
            send({ method: 'Page.loadEventFired', sessionId: 'S1', params: { timestamp: 1 } });
            break;
          case 'Runtime.evaluate':
            reply({ result: { value: String(msg.params?.['expression']).includes('location.href') ? 'https://fake.test/' : true } });
            break;
          case 'DOM.getBoxModel':
            if (msg.params?.['backendNodeId'] === 404) send({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: 'No node with given id found' } });
            else reply({ model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } });
            break;
          case 'Accessibility.getFullAXTree':
            reply({ nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }, { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 7 }] });
            break;
          case 'Page.startScreencast':
            reply({});
            castFrame();
            break;
          case 'Page.screencastFrameAck':
            fake.acks.push(Date.now());
            reply({});
            castFrame();
            break;
          default:
            reply({});
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = (server.address() as { port: number }).port;
  fake.close = () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return fake;
}

/** The driver in serve mode, with line-at-a-time reading of what it prints. */
function serveDriver(port: number) {
  const child = spawn(python!, [join(here, 'driver.py'), '--serve', String(port)]) as ChildProcessWithoutNullStreams;
  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  let partial = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    partial += chunk;
    for (let i = partial.indexOf('\n'); i >= 0; i = partial.indexOf('\n')) {
      lines.push(JSON.parse(partial.slice(0, i)) as Record<string, unknown>);
      partial = partial.slice(i + 1);
      for (const w of waiters.splice(0)) w();
    }
  });
  const until = async (pred: (l: Record<string, unknown>) => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = lines.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out; saw ${JSON.stringify(lines).slice(0, 500)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  let next = 1;
  const request = async (body: Record<string, unknown>) => {
    const id = next++;
    child.stdin.write(`${JSON.stringify({ ...body, id, timeoutMs: 5000 })}\n`);
    return await until((l) => l['id'] === id);
  };
  return { child, lines, until, request };
}

let fake: FakeChromium | undefined;
let driver: ReturnType<typeof serveDriver> | undefined;

afterEach(async () => {
  driver?.child.kill();
  driver = undefined;
  await fake?.close();
  fake = undefined;
});

describe.skipIf(!python)('driver.py --serve', { timeout: 30_000 }, () => {
  it('answers many requests over one websocket and one attach', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const step = { op: 'send', method: 'Page.enable', session: true };
    expect(await driver.request({ targetId: 'T1', steps: [step] })).toMatchObject({ ok: true, results: [{}] });
    expect(await driver.request({ targetId: 'T1', steps: [step, step] })).toMatchObject({ ok: true, results: [{}, {}] });
    expect(fake.connections).toBe(1);
    expect(fake.received.filter((m) => m.method === 'Target.attachToTarget')).toHaveLength(1);
  });

  it('runs page actions in one round, and stops at the first that fails', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const out = await driver.request({
      targetId: 'T1',
      steps: [
        { op: 'action', do: 'goto', url: 'https://fake.test/', loadTimeoutMs: 2000 },
        { op: 'action', do: 'click', ref: 'e7' },
        { op: 'action', do: 'snapshot' },
        { op: 'action', do: 'click', ref: 'e404' },
        { op: 'action', do: 'snapshot' },
      ],
    });
    const results = out['results'] as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ url: 'https://fake.test/', loaded: true });
    expect(results[1]).toMatchObject({ ref: 'e7', navigated: false });
    expect((results[2]?.['nodes'] as unknown[]).length).toBe(2);
    expect(String(results[3]?.['error'])).toMatch(/e404 is no longer on the page/);
    expect(results[4]).toEqual({ skipped: true });
    // The click pressed and released at the centre of the box.
    const press = fake.received.find((m) => m.method === 'Input.dispatchMouseEvent' && m.params?.['type'] === 'mousePressed');
    expect(press?.params).toMatchObject({ x: 20, y: 20 });
  });

  it('pushes screencast frames, acked no faster than the rate asked for', async () => {
    fake = await fakeChromium(4);
    driver = serveDriver(fake.port);
    expect(await driver.request({ op: 'screencast', targetId: 'T1', fps: 10 })).toMatchObject({ ok: true });
    await driver.until((l) => l['event'] === 'frame' && l['data'] === 'F4');
    const frames = driver.lines.filter((l) => l['event'] === 'frame');
    expect(frames[0]).toMatchObject({ targetId: 'T1', data: 'F1', width: 800, height: 600 });
    // At 10 fps the driver waits ~90ms before each ack, so Chromium cannot outrun the viewer.
    await new Promise((r) => setTimeout(r, 300));
    const gaps = fake.acks.slice(1).map((t, i) => t - fake!.acks[i]!);
    expect(fake.acks.length).toBeGreaterThanOrEqual(3);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(70);
    expect(await driver.request({ op: 'screencastStop', targetId: 'T1' })).toMatchObject({ ok: true });
    expect(fake.received.some((m) => m.method === 'Page.stopScreencast')).toBe(true);
  });

  it('keeps acking while a long request is in flight, so the screen does not freeze', async () => {
    fake = await fakeChromium(4);
    driver = serveDriver(fake.port);
    await driver.request({ op: 'screencast', targetId: 'T1', fps: 10 });
    await driver.until((l) => l['data'] === 'F1');
    // A wait that never fires holds the request for a second; frames still flow.
    const out = await driver.request({ targetId: 'T1', steps: [{ op: 'wait', event: 'Never.fires', session: true, timeoutMs: 1000, optional: true }] });
    expect(out).toMatchObject({ ok: true, results: [{ fired: false }] });
    expect(driver.lines.filter((l) => l['event'] === 'frame').length).toBe(4);
  });

  it('reports an unreachable browser and leaves when stdin closes', async () => {
    driver = serveDriver(1);
    expect(await driver.request({ steps: [] })).toMatchObject({ ok: false, kind: 'unreachable' });
    const exited = new Promise<number | null>((resolve) => driver!.child.on('exit', resolve));
    driver.child.stdin.end();
    expect(await exited).toBe(0);
  });
});
