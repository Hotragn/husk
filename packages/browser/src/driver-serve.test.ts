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
  /** What the clicked element says of itself. */
  element: { disabled?: boolean; hidden?: boolean; gone?: boolean };
  /** The node a hit test finds, and whether it is inside the clicked element. */
  hit: number;
  within: boolean;
  /** What a role and name query finds. */
  matches: Array<{ backendDOMNodeId: number; role: { value: string } }>;
  /** How far each successive box reading has moved, for an element still sliding into place. */
  shifts: number[];
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
  const fake = {
    received: [] as Cdp[],
    connections: 0,
    acks: [] as number[],
    element: {},
    hit: 7,
    within: true,
    matches: [{ backendDOMNodeId: 7, role: { value: 'button' } }],
    shifts: [],
  } as unknown as FakeChromium;
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
          case 'DOM.getBoxModel': {
            const d = fake.shifts.shift() ?? 0;
            if (msg.params?.['backendNodeId'] === 404) send({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: 'No node with given id found' } });
            else reply({ model: { content: [10 + d, 10, 30 + d, 10, 30 + d, 30, 10 + d, 30] } });
            break;
          }
          case 'DOM.resolveNode':
            if (msg.params?.['backendNodeId'] === 404) send({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: 'No node with given id found' } });
            else reply({ object: { objectId: `O${String(msg.params?.['backendNodeId'])}` } });
            break;
          case 'Runtime.callFunctionOn': {
            // Told apart by what each asks: the click's state, containment, a description.
            const fn = String(msg.params?.['functionDeclaration']);
            const value = fn.includes('getComputedStyle') ? fake.element : fn.includes('ShadowRoot') ? fake.within : fn.includes('className') ? '<div.backdrop> "Backdrop"' : undefined;
            reply({ result: { value } });
            break;
          }
          case 'DOM.getNodeForLocation':
            reply({ backendNodeId: fake.hit });
            break;
          case 'Accessibility.queryAXTree':
            reply({ nodes: fake.matches });
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
/**
 * The host's side of a script's questions, as the session answers them: a URL
 * with "evil" in it is refused by policy, anything else is allowed -- and
 * normalised, as `assertUrlAllowed` does, so a test can tell the driver went
 * to the host's URL and not the script's.
 */
function answerHost(msg: Record<string, unknown>): Record<string, unknown> {
  if (msg['op'] === 'checkUrl') {
    const url = String(msg['url']);
    return url.includes('evil') ? { error: `network policy refuses ${new URL(url).hostname}` } : { value: new URL(url).toString() };
  }
  if (msg['op'] === 'compact') return { value: (msg['nodes'] as unknown[]).map((_, i) => ({ ref: `e${i}`, role: 'button', name: 'Go' })) };
  return { error: 'unknown' };
}

function serveDriver(port: number) {
  const child = spawn(python!, [join(here, 'driver.py'), '--serve', String(port)]) as ChildProcessWithoutNullStreams;
  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  let partial = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    partial += chunk;
    for (let i = partial.indexOf('\n'); i >= 0; i = partial.indexOf('\n')) {
      const msg = JSON.parse(partial.slice(0, i)) as Record<string, unknown>;
      lines.push(msg);
      if (msg['event'] === 'host') child.stdin.write(`${JSON.stringify({ op: 'hostReply', call: msg['call'], ...answerHost(msg) })}\n`);
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

  const clicking = async (step: Record<string, unknown>) =>
    ((await driver!.request({ targetId: 'T1', steps: [{ op: 'action', do: 'click', ...step }] }))['results'] as Array<Record<string, unknown>>)[0]!;
  const pressed = () => fake!.received.filter((m) => m.method === 'Input.dispatchMouseEvent' && m.params?.['type'] === 'mousePressed').length;

  it('refuses a click that would do nothing or land elsewhere, saying why, and force still clicks', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    fake.element = { disabled: true };
    expect(String((await clicking({ ref: 'e7' }))['error'])).toMatch(/e7 is disabled/);
    fake.element = { hidden: true };
    expect(String((await clicking({ ref: 'e7' }))['error'])).toMatch(/e7 is not visible/);
    fake.element = {};
    fake.hit = 99;
    fake.within = false;
    expect(String((await clicking({ ref: 'e7' }))['error'])).toMatch(/e7 is covered: a click on it would land on <div\.backdrop> "Backdrop" instead/);
    expect(pressed()).toBe(0);
    // Without the checks, a press at the centre, as clicks always did.
    expect(await clicking({ ref: 'e7', force: true })).toMatchObject({ ref: 'e7', checked: false });
    expect(pressed()).toBe(1);
    // Landing on something inside the element is landing on it.
    fake.within = true;
    expect(await clicking({ ref: 'e7' })).toMatchObject({ ref: 'e7', checked: true });
  });

  it('refuses a role and name that match more than one element, and force takes the first', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    fake.matches = [
      { backendDOMNodeId: 7, role: { value: 'button' } },
      { backendDOMNodeId: 8, role: { value: 'button' } },
    ];
    expect(String((await clicking({ role: 'button', name: 'OK' }))['error'])).toMatch(/2 elements have role 'button' and name 'OK'/);
    expect(await clicking({ role: 'button', name: 'OK', force: true })).toMatchObject({ ref: 'e7' });
    // The text inside a button is that button, not a second match.
    fake.matches = [
      { backendDOMNodeId: 7, role: { value: 'button' } },
      { backendDOMNodeId: 70, role: { value: 'StaticText' } },
    ];
    expect(await clicking({ name: 'OK' })).toMatchObject({ ref: 'e7', checked: true });
  });

  it('waits for a moving element to settle, and refuses one that never does', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    fake.shifts = [0, 6];
    expect(await clicking({ ref: 'e7' })).toMatchObject({ ref: 'e7', checked: true });
    fake.shifts = Array.from({ length: 20 }, (_, i) => i * 6);
    expect(String((await clicking({ ref: 'e7' }))['error'])).toMatch(/e7 is still moving/);
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

describe.skipIf(!python)('driver.py --serve, running a script', { timeout: 30_000 }, () => {
  const script = (source: string, limitSec = 5) => ({
    targetId: 'T1',
    steps: [{ op: 'action', do: 'script', source, limitSec, timeoutMs: limitSec * 1000 }],
  });
  const outcome = (answer: Record<string, unknown>) => (answer['results'] as Array<Record<string, unknown>>)[0]!;

  it('branches on the page and returns what it printed and its result', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const out = outcome(
      await driver.request(
        script(
          [
            'if page.has_text("Go"):',
            '    page.click(ref="e7")',
            '    print("clicked")',
            'else:',
            '    print("no button")',
            'result = {"url": page.url(), "links": [n["name"] for n in page.snapshot()]}',
          ].join('\n'),
        ),
      ),
    );
    expect(out).toMatchObject({ output: 'clicked\n', result: { url: 'https://fake.test/', links: ['Go', 'Go'] }, error: null });
    expect(fake.received.some((m) => m.method === 'Input.dispatchMouseEvent')).toBe(true);
  });

  it('checks every goto with the host first, and a refusal is the script’s to handle', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const out = outcome(
      await driver.request(
        script(
          [
            'try:',
            '    page.goto("https://evil.test/")',
            'except PageError as e:',
            '    print("refused:", e)',
            'page.goto("https://fake.test/next")',
          ].join('\n'),
        ),
      ),
    );
    expect(out['error']).toBeNull();
    expect(String(out['output'])).toMatch(/^refused: network policy refuses evil\.test/);
    const navigations = fake.received.filter((m) => m.method === 'Page.navigate').map((m) => m.params?.['url']);
    expect(navigations).toEqual(['https://fake.test/next']);
    expect(driver.lines.filter((l) => l['event'] === 'host' && l['op'] === 'checkUrl')).toHaveLength(2);
  });

  it('kills a script that runs past its limit, and the driver goes on', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const started = Date.now();
    const out = outcome(await driver.request(script('print("start")\nwhile True:\n    pass', 1)));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toMatchObject({ output: 'start\n', error: expect.stringMatching(/still running at its 1 s limit/) });
    expect(await driver.request({ targetId: 'T1', steps: [{ op: 'send', method: 'Page.enable', session: true }] })).toMatchObject({ ok: true });
  });

  it('caps what a script prints', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const out = outcome(await driver.request(script('for i in range(2000):\n    print("x" * 100)')));
    expect(out['truncated']).toBe(true);
    expect(String(out['output']).length).toBe(64 * 1024);
  });

  it('returns a crash as its traceback, pointing at the script’s own line', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const out = outcome(await driver.request(script('x = 1\ny = x / 0')));
    expect(String(out['error'])).toMatch(/File "<script>", line 2/);
    expect(String(out['error'])).toMatch(/ZeroDivisionError/);
    const syntax = outcome(await driver.request(script('if True print(1)')));
    expect(String(syntax['error'])).toMatch(/SyntaxError/);
  });

  it('keeps the screencast going through a script, and after one crashes', async () => {
    fake = await fakeChromium(6);
    driver = serveDriver(fake.port);
    await driver.request({ op: 'screencast', targetId: 'T1', fps: 10 });
    await driver.until((l) => l['data'] === 'F1');
    // Frames are acked while the script sleeps, then it crashes.
    const out = outcome(await driver.request(script('sleep(0.6)\nraise RuntimeError("boom")')));
    expect(String(out['error'])).toMatch(/RuntimeError: boom/);
    expect(driver.lines.filter((l) => l['event'] === 'frame').length).toBeGreaterThanOrEqual(4);
    await driver.until((l) => l['data'] === 'F6');
    expect(await driver.request({ targetId: 'T1', steps: [{ op: 'send', method: 'Page.enable', session: true }] })).toMatchObject({ ok: true });
  });
});

describe.skipIf(!python)('driver.py --serve, a script that misbehaves', { timeout: 60_000 }, () => {
  const script = (source: string, limitSec = 20) => ({
    targetId: 'T1',
    steps: [{ op: 'action', do: 'script', source, limitSec, timeoutMs: limitSec * 1000 }],
  });
  const outcome = (answer: Record<string, unknown>) => (answer['results'] as Array<Record<string, unknown>>)[0]!;
  const alive = async () =>
    expect(await driver!.request({ targetId: 'T1', steps: [{ op: 'send', method: 'Page.enable', session: true }] })).toMatchObject({ ok: true });

  it('goes where the host said, not where the script said', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    outcome(await driver.request(script('page.goto("HTTPS://FAKE.TEST:443/Next")')));
    expect(fake.received.filter((m) => m.method === 'Page.navigate').map((m) => m.params?.['url'])).toEqual(['https://fake.test/Next']);
  });

  it('is stopped when it sends page calls and never reads the answers, and the driver goes on', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const started = Date.now();
    // Straight to the real pipe, past `page`, then never reading stdin again.
    const flood = ['import json, sys', 'for i in range(20000):', '    sys.__stdout__.write(json.dumps({"t": "call", "op": "url"}) + "\\n")', 'sys.__stdout__.flush()', 'sleep(60)'].join('\n');
    const out = outcome(await driver.request(script(flood)));
    expect(String(out['error'])).toMatch(/stopped reading the answers/);
    expect(Date.now() - started).toBeLessThan(20_000);
    await alive();
  });

  it('caps a huge result, a huge error and a huge raw line', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const big = outcome(await driver.request(script('result = "x" * 10**7')));
    expect(big['resultTruncated']).toBe(true);
    expect(String(big['result']).length).toBeLessThanOrEqual(64 * 1024);
    const raised = outcome(await driver.request(script('raise ValueError("y" * 10**7)')));
    expect(String(raised['error']).length).toBeLessThan(17 * 1024);
    expect(String(raised['error'])).toMatch(/ValueError/);
    // A line past the reader's limit, written past the runner, is dropped as it is read.
    const raw = ['import json, sys', 'sys.__stdout__.write(json.dumps({"t": "done", "result": "z" * (2 * 1024 * 1024)}) + "\\n")', 'sys.__stdout__.flush()', 'result = "small"'].join('\n');
    const line = outcome(await driver.request(script(raw)));
    expect(line['result']).toBe('small');
    expect(String(line['output'])).toMatch(/a line of over 1048576 bytes was dropped/);
    await alive();
  });

  it.skipIf(process.platform !== 'linux')('kills a grandchild that left with setsid', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const escape = [
      'import subprocess, sys',
      'p = subprocess.Popen([sys.executable, "-c", "import os, time; os.setsid(); time.sleep(120)"])',
      'sleep(0.5)',
      'print(p.pid)',
    ].join('\n');
    const out = outcome(await driver.request(script(escape)));
    const pid = Number(String(out['output']).trim());
    expect(pid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 500));
    const { readFileSync } = await import('node:fs');
    let state = 'gone';
    try {
      state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.charAt(0);
    } catch {
      // No /proc entry: the process is gone, which is the point.
    }
    expect(['gone', 'Z', 'X']).toContain(state);
  });
});
