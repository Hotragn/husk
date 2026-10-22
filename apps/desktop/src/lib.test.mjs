import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SLOT_H,
  SLOT_W,
  appIconPaths,
  computerWindowBounds,
  consoleUrl,
  daemonCommand,
  desktopComputers,
  desktopUrl,
  dockBounds,
  external,
  isNewer,
  launchFor,
  newlyWaiting,
  notchOf,
  pillBounds,
  readDaemonRecord,
  runtimeBin,
  sameOrigin,
  toOpen,
  trayStatus,
} from './lib.mjs';

test('the bundled Husk is in resources when packaged, and the monorepo build from a checkout', () => {
  assert.equal(
    runtimeBin({ isPackaged: true, resourcesPath: '/Applications/Husk.app/Contents/Resources', appPath: '' }),
    join('/Applications/Husk.app/Contents/Resources', 'runtime', 'node_modules', '@husk-ai', 'mcp', 'dist', 'bin.js'),
  );
  assert.ok(runtimeBin({ isPackaged: false, resourcesPath: '', appPath: '/repo/apps/desktop' }).endsWith(join('packages', 'mcp', 'dist', 'bin.js')));
});

test('inside a Linux AppImage, chat apps and the daemon start the AppImage itself', () => {
  const env = { APPIMAGE: '/home/me/Husk.AppImage', ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' };
  assert.deepEqual(launchFor('/tmp/.mount_x/husk', '/tmp/.mount_x/bin.js', env), { command: '/home/me/Husk.AppImage', args: ['--husk-mcp'] });
  const d = daemonCommand({ execPath: '/tmp/.mount_x/husk', bin: '/tmp/.mount_x/bin.js', env });
  assert.equal(d.command, '/home/me/Husk.AppImage');
  assert.deepEqual(d.args, ['--husk-mcp', '--daemon']);
  assert.equal(d.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('versions compare numerically', () => {
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
});

test('chat apps run the app binary as Node, with nothing else installed', () => {
  assert.deepEqual(launchFor('C:/Program Files/Husk/Husk.exe', 'C:/x/bin.js'), {
    command: 'C:/Program Files/Husk/Husk.exe',
    args: ['C:/x/bin.js'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
});

test('reads the running Husk from HUSK_HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'husk-desk-'));
  try {
    assert.equal(readDaemonRecord({ HUSK_HOME: home }), undefined);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:7377', token: 't', pid: 4, version: '0.2.0' }));
    assert.equal(readDaemonRecord({ HUSK_HOME: home }).pid, 4);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('opens the console signed in, on a panel', () => {
  const rec = { url: 'http://127.0.0.1:7377', token: 'a b' };
  assert.equal(consoleUrl(rec), 'http://127.0.0.1:7377/#token=a%20b');
  assert.equal(consoleUrl(rec, 'connect'), 'http://127.0.0.1:7377/#token=a%20b&panel=connect');
});

test('keeps the window on the console, and sends only web links out', () => {
  assert.equal(sameOrigin('http://127.0.0.1:7377/#/home', 'http://127.0.0.1:7377'), true);
  assert.equal(sameOrigin('https://evil.example/', 'http://127.0.0.1:7377'), false);
  assert.equal(external('https://github.com/Hotragn/husk'), true);
  assert.equal(external('file:///etc/passwd'), false);
  assert.equal(external('javascript:alert(1)'), false);
});

test('the tray says what is running and what is waiting, and notifies once per handoff', () => {
  const overview = {
    computers: [{ state: 'running' }, { state: 'stopped' }, { state: 'running' }],
    handoffs: [{ handoffId: 'h1', reason: 'Sign in' }],
  };
  assert.equal(trayStatus(overview).label, '2 computers running · 1 waiting for you');
  assert.equal(trayStatus(undefined).label, 'Husk is starting');
  assert.deepEqual(newlyWaiting([], overview.handoffs).map((h) => h.handoffId), ['h1']);
  assert.deepEqual(newlyWaiting(overview.handoffs, overview.handoffs), []);
  // Taken by the person from the console: not waiting on them, so no notification.
  const taken = { ...overview, handoffs: [...overview.handoffs, { handoffId: 'h2', runId: 'person', reason: 'You took over this computer' }] };
  assert.equal(trayStatus(taken).label, '2 computers running · 1 waiting for you');
  assert.deepEqual(trayStatus(taken).waiting.map((h) => h.handoffId), ['h1']);
});

const workArea = { x: 0, y: 25, width: 1440, height: 875 };

test('the row of 3D computers sits in the bottom-right corner, one slot per computer', () => {
  const one = dockBounds(workArea, 1);
  const three = dockBounds(workArea, 3);
  assert.equal(three.width - one.width, 2 * SLOT_W);
  assert.ok(one.height > SLOT_H, 'room above the row for a tooltip');
  for (const b of [one, three]) {
    assert.ok(b.x + b.width <= workArea.x + workArea.width && b.y + b.height <= workArea.y + workArea.height, 'inside the work area');
  }
});

test('computer windows open above the row, each up and to the left of the last, never off the screen', () => {
  const a = computerWindowBounds(workArea, 0);
  const b = computerWindowBounds(workArea, 1);
  assert.ok(b.x < a.x && b.y < a.y);
  assert.ok(a.y + a.height <= dockBounds(workArea, 1).y + SLOT_H, 'above the 3D computers');
  const tiny = computerWindowBounds({ x: 0, y: 0, width: 400, height: 300 }, 3);
  assert.ok(tiny.x >= 0 && tiny.y >= 0);
});

test('the notch hangs from the top centre, and wraps a real notch only on a notch-tall Mac menu bar', () => {
  const display = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 944 } };
  const p = pillBounds(display, 2);
  assert.equal(p.y, 0);
  assert.equal(p.x + p.width / 2, 756);
  assert.deepEqual(notchOf('darwin', display), { gap: 200, height: 38 });
  assert.equal(notchOf('darwin', { ...display, workArea: { ...display.workArea, y: 24 } }), undefined);
  assert.equal(notchOf('win32', display), undefined, 'Windows gets the same pill, centred, with no gap');
});

const overview = {
  computers: [
    { id: 'cmp_a', state: 'running', provider: 'docker', chatLabel: 'Claude Code · chat started 09:41', platform: 'Claude Code' },
    { id: 'cmp_b', state: 'running', provider: 'ssh', name: 'box', platform: 'Claude Desktop' },
    { id: 'cmp_c', state: 'stopped', provider: 'docker' },
    { id: 'cmp_d', state: 'destroyed', provider: 'docker' },
  ],
  handoffs: [
    { handoffId: 'hnd_1', runId: 'person', computerId: 'cmp_a', reason: 'You took over this computer' },
    { handoffId: 'hnd_2', runId: 'chat', computerId: 'cmp_b', reason: 'Sign in to GitHub' },
  ],
  activity: {
    cmp_a: { at: '2026-10-22T10:00:05.000Z', tool: 'browser_goto', summary: 'https://example.com' },
    cmp_b: { at: '2026-10-22T09:00:00.000Z', tool: 'shell' },
  },
};

test('every window is told who holds each computer, and where its window is', () => {
  const windows = new Map([['cmp_a', { state: 'minimized', pinned: false }]]);
  const [a, b, c, ...rest] = desktopComputers(overview, windows, { 'Claude Desktop': 'data:image/png;base64,x' });
  assert.equal(rest.length, 0, 'a destroyed computer is gone');
  assert.deepEqual(a, {
    id: 'cmp_a',
    label: 'Claude Code · chat started 09:41',
    platform: 'Claude Code',
    state: 'running',
    window: 'minimized',
    pinned: false,
    handoffId: 'hnd_1',
    held: true,
    last: { tool: 'browser_goto', summary: 'https://example.com', at: '2026-10-22T10:00:05.000Z' },
    live: true,
  });
  assert.equal(b.waiting, 'Sign in to GitHub');
  assert.equal(b.held, false);
  assert.equal(b.live, false, 'an ssh screen is an exec per frame, which counts as use');
  assert.equal(b.icon, 'data:image/png;base64,x');
  assert.equal(c.window, 'closed');
  assert.equal(c.label, 'cmp_c');
  assert.deepEqual(desktopComputers(undefined, windows), []);
});

test('a window opens by itself only for a running computer a chat used since the app started, once', () => {
  const since = Date.parse('2026-10-22T09:30:00.000Z');
  assert.deepEqual(toOpen(overview, since, new Set()), ['cmp_a']);
  assert.deepEqual(toOpen(overview, since, new Set(['cmp_a'])), [], 'not again, even after the person closed it');
  assert.deepEqual(toOpen(undefined, since, new Set()), []);
});

test('desktop windows are the console signed in, on their own view', () => {
  assert.equal(desktopUrl({ url: 'http://127.0.0.1:7377', token: 'a b' }, 'computer', 'cmp_a'), 'http://127.0.0.1:7377/#token=a%20b&view=computer&id=cmp_a');
  assert.equal(desktopUrl({ url: 'http://127.0.0.1:7377' }, 'dock'), 'http://127.0.0.1:7377/#view=dock');
});

test('a chat app’s icon is looked for where it is usually installed, and nowhere for the terminal ones', () => {
  assert.deepEqual(appIconPaths('Cursor', 'darwin'), ['/Applications/Cursor.app']);
  assert.deepEqual(appIconPaths('Claude Desktop', 'win32', { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` }), [
    String.raw`C:\Users\me\AppData\Local\AnthropicClaude\claude.exe`,
  ]);
  assert.deepEqual(appIconPaths('Claude Code', 'darwin'), []);
  assert.deepEqual(appIconPaths('Cursor', 'linux'), []);
});
