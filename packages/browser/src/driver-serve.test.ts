import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compactAxTree } from './page.js';
import type { AxNodeLike } from './page.js';

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
  /** The page's document now: a new loader id is a page load. */
  loader: string;
  /** Events the page sends when a click's button is released: a dialog, a download, a new tab. */
  onRelease: unknown[];
  /** A frame in the page's process, its <iframe> node 9, whose nodes number afresh: its document now. */
  child?: { loader: string };
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
    loader: 'L1',
    onRelease: [],
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
          case 'Input.dispatchMouseEvent':
            // What the page does on a click, before the click's own answer, as Chromium does.
            if (msg.params?.['type'] === 'mouseReleased') for (const e of fake.onRelease) send(e);
            reply({});
            break;
          case 'Page.getFrameTree':
            reply({
              frameTree: {
                frame: { id: 'F', loaderId: fake.loader },
                ...(fake.child ? { childFrames: [{ frame: { id: 'C', parentId: 'F', loaderId: fake.child.loader, url: 'https://fake.test/inner' } }] } : {}),
              },
            });
            break;
          case 'DOM.getFrameOwner':
            if (fake.child && msg.params?.['frameId'] === 'C') reply({ backendNodeId: 9 });
            else send({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: 'Frame with the given id was not found.' } });
            break;
          case 'Accessibility.queryAXTree':
            reply({ nodes: fake.matches });
            break;
          case 'Accessibility.getFullAXTree':
            if (msg.params?.['frameId'] === 'C') {
              // The frame's own tree: its node 7 is not the page's node 7.
              reply({ nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }, { nodeId: '2', parentId: '1', role: { value: 'textbox' }, name: { value: 'Name' }, backendDOMNodeId: 7 }] });
              break;
            }
            reply({
              nodes: [
                { nodeId: '1', role: { value: 'RootWebArea' }, childIds: fake.child ? ['2', '3'] : ['2'] },
                { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 7 },
                ...(fake.child ? [{ nodeId: '3', parentId: '1', role: { value: 'Iframe' }, name: { value: 'inner' }, backendDOMNodeId: 9 }] : []),
              ],
            });
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

/** A snapshot, as a session takes before it acts on refs: it records the document each ref came from. */
const snapped = () => driver!.request({ targetId: 'T1', steps: [{ op: 'action', do: 'snapshot' }] });

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
    await snapped();
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
    // No snapshot showed e404: it is refused before anything resolves its id.
    expect(String(results[3]?.['error'])).toMatch(/e404 is from a snapshot this browser has no record of/);
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
    await snapped();
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
    await snapped();
    fake.shifts = [0, 6];
    expect(await clicking({ ref: 'e7' })).toMatchObject({ ref: 'e7', checked: true });
    fake.shifts = Array.from({ length: 20 }, (_, i) => i * 6);
    expect(String((await clicking({ ref: 'e7' }))['error'])).toMatch(/e7 is still moving/);
  });

  it('refuses a ref from an earlier page, whatever has its id now, and force does not change that', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const snapshot = await driver.request({ targetId: 'T1', steps: [{ op: 'action', do: 'snapshot' }] });
    expect((snapshot['results'] as Array<Record<string, unknown>>)[0]).toMatchObject({ document: 'L1' });
    expect(await clicking({ ref: 'e7' })).toMatchObject({ ref: 'e7' });
    fake.loader = 'L2'; // the page loaded another document
    expect(String((await clicking({ ref: 'e7' }))['error'])).toMatch(/e7 is from an earlier page/);
    expect(String((await clicking({ ref: 'e7', force: true }))['error'])).toMatch(/e7 is from an earlier page/);
    // A role and a name are found afresh on the page as it is.
    expect(await clicking({ role: 'button', name: 'Go' })).toMatchObject({ ref: 'e7' });
  });

  it('checks a ref against the host’s record when this driver saw no snapshot', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    expect(String((await clicking({ ref: 'e7', document: 'L0' }))['error'])).toMatch(/e7 is from an earlier page/);
    expect(await clicking({ ref: 'e7', document: 'L1' })).toMatchObject({ ref: 'e7' });
  });

  it('types into the field itself, not into whatever the page calls active', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    await snapped();
    const out = await driver.request({ targetId: 'T1', steps: [{ op: 'action', do: 'fill', ref: 'e7', text: 'hello' }] });
    expect((out['results'] as Array<Record<string, unknown>>)[0]).toMatchObject({ ref: 'e7' });
    const onField = fake.received.filter((m) => m.method === 'Runtime.callFunctionOn' && m.params?.['objectId'] === 'O7').map((m) => String(m.params?.['functionDeclaration']));
    expect(onField.some((f) => f.includes('select()'))).toBe(true);
    expect(onField.some((f) => f.includes("new Event('change'"))).toBe(true);
    expect(fake.received.some((m) => m.method === 'Runtime.evaluate' && String(m.params?.['expression']).includes('activeElement'))).toBe(false);
    expect(fake.received.find((m) => m.method === 'Input.insertText')?.params).toEqual({ text: 'hello' });
  });

  it('answers a dialog a click opens, says how, and accepts a confirm only when asked', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    await snapped();
    fake.onRelease = [{ method: 'Page.javascriptDialogOpening', sessionId: 'S1', params: { type: 'confirm', message: 'Delete?' } }];
    expect(await clicking({ ref: 'e7' })).toMatchObject({ dialogs: [{ type: 'confirm', message: 'Delete?', answer: 'dismissed' }] });
    expect(await clicking({ ref: 'e7', dialog: 'accept' })).toMatchObject({ dialogs: [{ type: 'confirm', answer: 'accepted' }] });
    // An alert has only OK.
    fake.onRelease = [{ method: 'Page.javascriptDialogOpening', sessionId: 'S1', params: { type: 'alert', message: 'Saved' } }];
    expect(await clicking({ ref: 'e7' })).toMatchObject({ dialogs: [{ type: 'alert', answer: 'accepted' }] });
    const answers = fake.received.filter((m) => m.method === 'Page.handleJavaScriptDialog').map((m) => m.params?.['accept']);
    expect(answers).toEqual([false, true, true]);
  });

  it('follows a download a click starts to its end, into the folder the host names', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    fake.onRelease = [
      { method: 'Browser.downloadWillBegin', params: { guid: 'g1', url: 'https://fake.test/report.pdf', suggestedFilename: 'report.pdf' } },
      { method: 'Browser.downloadProgress', params: { guid: 'g1', state: 'completed', totalBytes: 1234, receivedBytes: 1234 } },
    ];
    const folder = join(tmpdir(), `husk-downloads-${process.pid}`);
    try {
      const steps = [{ op: 'action', do: 'snapshot' }, { op: 'action', do: 'click', ref: 'e7' }];
      const res = await driver.request({ targetId: 'T1', downloads: folder, steps });
      expect((res['results'] as unknown[])[1]).toMatchObject({ downloads: [{ name: 'report.pdf', state: 'completed', bytes: 1234 }] });
      // The driver runs from a tmpfs in a computer, so only the host can say where downloads belong.
      expect(fake.received.find((m) => m.method === 'Browser.setDownloadBehavior')?.params).toEqual({ behavior: 'allow', downloadPath: folder, eventsEnabled: true });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('turns downloads on only when the host names a folder for them', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    await clicking({ ref: 'e7' });
    expect(fake.received.some((m) => m.method === 'Browser.setDownloadBehavior')).toBe(false);
  });

  it('says which tab a click opened', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    await snapped();
    // A new tab starts out blank and gets its address when its page commits.
    fake.onRelease = [
      { method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T2', type: 'page', url: 'about:blank', openerId: 'T1' } } },
      { method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'T2', type: 'page', url: 'https://fake.test/new', openerId: 'T1' } } },
    ];
    expect(await clicking({ ref: 'e7' })).toMatchObject({ popups: [{ targetId: 'T2', url: 'https://fake.test/new' }] });
    expect(fake.received.some((m) => m.method === 'Target.setDiscoverTargets')).toBe(true);
  });

  it('reads a frame into the snapshot under its <iframe>, its refs naming the frame', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    fake.child = { loader: 'C1' };
    const out = (await driver.request({ targetId: 'T1', steps: [{ op: 'action', do: 'snapshot' }] }))['results'] as Array<Record<string, unknown>>;
    const snap = out[0]!;
    expect(snap['frames']).toEqual({ f1: { id: 'C', document: 'C1' } });
    // The page's node 7 is e7; the frame's node 7 is f1e7, under the frame's <iframe>.
    expect(compactAxTree(snap['nodes'] as AxNodeLike[])).toEqual([
      { ref: 'e7', role: 'button', name: 'Go', depth: 0 },
      { ref: 'e9', role: 'Iframe', name: 'inner', depth: 0 },
      { ref: 'f1e7', role: 'textbox', name: 'Name', depth: 1 },
    ]);
  });

  it("acts on a frame's node in its frame's document, and refuses it once the frame has loaded another", async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    fake.child = { loader: 'C1' };
    await driver.request({ targetId: 'T1', steps: [{ op: 'action', do: 'snapshot' }] });
    const typing = async () =>
      ((await driver!.request({ targetId: 'T1', steps: [{ op: 'action', do: 'fill', ref: 'f1e7', text: 'hi' }] }))['results'] as Array<Record<string, unknown>>)[0]!;
    expect(await typing()).toEqual({ ref: 'f1e7' });
    // The page's own document has not changed, only the frame's: the frame's refs go, the page's stay.
    fake.child.loader = 'C2';
    expect(String((await typing())['error'])).toMatch(/f1e7 is from an earlier page/);
    expect(await clicking({ ref: 'e7' })).toMatchObject({ ref: 'e7', checked: true });
    fake.child = undefined;
    expect(String((await typing())['error'])).toMatch(/f1e7 is in a frame that is no longer on the page/);
  });

  it("keeps the host's frame numbers, for a driver that keeps nothing between requests", async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    fake.child = { loader: 'C1' };
    const out = (await driver.request({ targetId: 'T1', steps: [{ op: 'action', do: 'snapshot', frames: { C: 3 } }] }))['results'] as Array<Record<string, unknown>>;
    expect(out[0]!['frames']).toEqual({ f3: { id: 'C', document: 'C1' } });
    // And the host's record of the frame is enough to act there.
    const typed = (await driver.request({ targetId: 'T1', steps: [{ op: 'action', do: 'fill', ref: 'f3e7', text: 'hi', frame: 'C', document: 'C1' }] }))['results'] as Array<Record<string, unknown>>;
    expect(typed[0]).toEqual({ ref: 'f3e7' });
  });

  it('stops a document load the network policy refuses, says so, and lets the rest go', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    const paused = (requestId: string, url: string) => ({ method: 'Fetch.requestPaused', sessionId: 'S1', params: { requestId, resourceType: 'Document', request: { url } } });
    fake.onRelease = [paused('R1', 'http://169.254.169.254/latest/meta-data/'), paused('R2', 'https://example.com/next')];
    const policy = { network: null, loopbackIsOwn: true };
    const res = await driver.request({ targetId: 'T1', policy, steps: [{ op: 'action', do: 'snapshot' }, { op: 'action', do: 'click', ref: 'e7' }] });
    expect((res['results'] as unknown[])[1]).toMatchObject({ blocked: [{ url: 'http://169.254.169.254/latest/meta-data/', reason: 'an internal address' }] });
    const answered = fake.received.filter((m) => m.method?.startsWith('Fetch.') && m.method !== 'Fetch.enable').map((m) => [m.method, m.params?.['requestId']]);
    expect(answered).toEqual([
      ['Fetch.failRequest', 'R1'],
      ['Fetch.continueRequest', 'R2'],
    ]);
    // Every document of the tab, intercepted on its session before anything else is asked of it.
    expect(fake.received.find((m) => m.method === 'Fetch.enable')).toMatchObject({ sessionId: 'S1', params: { patterns: [{ resourceType: 'Document' }] } });
  });

  it('guards a new tab before it runs: its loads go by the policy and its dialogs are answered', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    await snapped();
    // A pop-up, held by auto-attach until the driver lets it go.
    fake.onRelease = [{ method: 'Target.attachedToTarget', params: { sessionId: 'S9', waitingForDebugger: true, targetInfo: { targetId: 'T9', type: 'page', url: '' } } }];
    await driver.request({ targetId: 'T1', policy: { network: { mode: 'full' }, loopbackIsOwn: false }, steps: [{ op: 'action', do: 'click', ref: 'e7' }] });
    const toPopup = fake.received.filter((m) => m.sessionId === 'S9').map((m) => m.method);
    expect(toPopup).toEqual(['Fetch.enable', 'Page.enable', 'Runtime.runIfWaitingForDebugger']);
    // Every tab, held when it is new: set up before the first request does anything.
    expect(fake.received.find((m) => m.method === 'Target.setAutoAttach' && !m.sessionId)?.params).toMatchObject({ waitForDebuggerOnStart: true, filter: [{ type: 'page' }] });
  });

  it('arms a click\'s wait just before it presses, and says what the wait found', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    await snapped();
    const res = await driver.request({
      targetId: 'T1',
      steps: [{ op: 'action', do: 'click', ref: 'e7', arm: 'window.__armed = 1', wait: { expression: 'window.__waited', what: 'text "Saved"' } }],
    });
    expect((res['results'] as unknown[])[0]).toMatchObject({ ref: 'e7', waited: { what: 'text "Saved"', found: true } });
    const order = fake.received
      .map((m) => (m.method === 'Runtime.evaluate' ? String(m.params?.['expression']) : m.method === 'Input.dispatchMouseEvent' ? `mouse ${String(m.params?.['type'])}` : ''))
      .filter((m) => m === 'window.__armed = 1' || m === 'window.__waited' || m.startsWith('mouse mousePressed'));
    expect(order).toEqual(['window.__armed = 1', 'mouse mousePressed', 'window.__waited']);
  });

  it('intercepts nothing when the host sends no policy', async () => {
    fake = await fakeChromium();
    driver = serveDriver(fake.port);
    await clicking({ ref: 'e7' });
    expect(fake.received.some((m) => m.method === 'Fetch.enable')).toBe(false);
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
    await snapped();
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
