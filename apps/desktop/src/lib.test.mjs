import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SLOT_H,
  SLOT_W,
  appIconPaths,
  computersWindowBounds,
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
  reachable,
  readDaemonRecord,
  restartDelay,
  runtimeBin,
  sameOrigin,
  shapeOf,
  shellPath,
  signedBuild,
  toOpen,
  trayComputers,
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
  // Taken by the person from the console: not waiting on them, so no notification, but theirs to give back.
  const taken = { ...overview, handoffs: [...overview.handoffs, { handoffId: 'h2', runId: 'person', reason: 'You took over this computer', computerId: 'cmp_x' }] };
  assert.equal(trayStatus(taken).label, '2 computers running · you hold 1 · 1 waiting for you');
  assert.deepEqual(trayStatus(taken).waiting.map((h) => h.handoffId), ['h1']);
  assert.deepEqual(trayStatus(taken).held, [{ handoffId: 'h2', label: 'cmp_x' }]);
  const named = { ...taken, computers: [...taken.computers, { id: 'cmp_x', state: 'running', chatLabel: 'Cursor · chat started 09:44' }] };
  assert.deepEqual(trayStatus(named).held, [{ handoffId: 'h2', label: 'Cursor · chat started 09:44' }]);
  assert.deepEqual(trayStatus(undefined).held, []);
});

const workArea = { x: 0, y: 25, width: 1440, height: 875 };

test('the corner row is small, in the bottom-right corner, one slot per computer', () => {
  const one = dockBounds(workArea, 1);
  const three = dockBounds(workArea, 3);
  assert.equal(three.width - one.width, 2 * SLOT_W);
  assert.ok(SLOT_W <= 48 && SLOT_H <= 48, 'small enough not to distract');
  assert.ok(one.height > SLOT_H && one.height <= 80, 'room above the row for its small label, and no more');
  for (const b of [one, three]) {
    assert.ok(b.x + b.width <= workArea.x + workArea.width && b.y + b.height <= workArea.y + workArea.height, 'inside the work area');
  }
});

test('the Computers window opens compact, just above the corner row, never off the screen', () => {
  const w = computersWindowBounds(workArea);
  assert.ok(w.width <= 520 && w.height <= 360, 'compact');
  assert.ok(w.x + w.width <= workArea.x + workArea.width && w.y + w.height <= dockBounds(workArea, 1).y + SLOT_H, 'above the corner row');
  const tiny = computersWindowBounds({ x: 0, y: 0, width: 400, height: 300 });
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

test('the computers on the screen are the running ones, each with who holds it and what it did', () => {
  const [a, b, ...rest] = desktopComputers(overview, undefined, { 'Claude Desktop': 'data:image/png;base64,x' });
  assert.equal(rest.length, 0, 'a stopped or destroyed computer is not a tab');
  assert.deepEqual(a, {
    id: 'cmp_a',
    label: 'Claude Code · chat started 09:41',
    platform: 'Claude Code',
    state: 'running',
    handoffId: 'hnd_1',
    held: true,
    last: { tool: 'browser_goto', summary: 'https://example.com', at: '2026-10-22T10:00:05.000Z' },
    live: true,
  });
  assert.equal(b.waiting, 'Sign in to GitHub');
  assert.equal(b.held, false);
  assert.equal(b.live, false, 'an ssh screen is an exec per frame, which counts as use');
  assert.equal(b.icon, 'data:image/png;base64,x');
  assert.equal(b.label, 'box');
  // The tab being shown stays a tab when its computer stops.
  assert.deepEqual(desktopComputers(overview, 'cmp_c').map((c) => c.id), ['cmp_a', 'cmp_b', 'cmp_c']);
  assert.deepEqual(desktopComputers(overview, 'cmp_d').map((c) => c.id), ['cmp_a', 'cmp_b']);
  assert.deepEqual(desktopComputers(undefined), []);
});

test('with "open by itself" on, only a running computer a chat used since the app started opens, once', () => {
  const since = Date.parse('2026-10-22T09:30:00.000Z');
  assert.deepEqual(toOpen(overview, since, new Set()), ['cmp_a']);
  assert.deepEqual(toOpen(overview, since, new Set(['cmp_a'])), [], 'not again, even after the person closed it');
  assert.deepEqual(toOpen(undefined, since, new Set()), []);
});

test('it opens as a chat’s call starts, not once it ends, and says what is running', () => {
  const since = Date.parse('2026-10-22T09:30:00.000Z');
  // cmp_b's last call ended before the app started, but another is running now.
  const busy = { ...overview, running: { cmp_b: { tool: 'browser_goto', since: '2026-10-22T10:01:00.000Z' } } };
  assert.deepEqual(toOpen(busy, since, new Set()), ['cmp_a', 'cmp_b']);
  assert.equal(desktopComputers(busy).find((c) => c.id === 'cmp_b').calling, 'browser_goto');
  assert.equal(desktopComputers(overview).find((c) => c.id === 'cmp_b').calling, undefined);
  assert.equal(desktopComputers(busy, undefined, {}, false).find((c) => c.id === 'cmp_b').calling, undefined, 'nothing is known to run while Husk is not answering');
});

test('desktop windows are the console signed in, on their own view', () => {
  assert.equal(desktopUrl({ url: 'http://127.0.0.1:7377', token: 'a b' }, 'computers'), 'http://127.0.0.1:7377/#token=a%20b&view=computers');
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

test('a shared Husk that is not answering is said so in the tray, not that it is starting', () => {
  assert.deepEqual(trayStatus(undefined, false), { label: 'Husk is not answering · trying again', waiting: [], held: [] });
  assert.equal(trayStatus(undefined).label, 'Husk is starting');
});

test('Husk is started again two seconds after the first try, the wait doubling to a minute', () => {
  const waits = [];
  let wait = 0;
  for (let i = 0; i < 8; i++) waits.push((wait = restartDelay(wait)));
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
});

test('a corner or notch page shapes only its own window, in whole pixels, and nothing it sends is taken as is', () => {
  const size = { width: 420, height: 360 };
  assert.deepEqual(shapeOf([{ x: 20.4, y: 0, width: 380.2, height: 32.5 }], size), [{ x: 20, y: 0, width: 381, height: 33 }]);
  assert.deepEqual(shapeOf([{ x: -10, y: 300, width: 500, height: 100 }], size), [{ x: 0, y: 300, width: 420, height: 60 }], 'cut to the window');
  assert.deepEqual(shapeOf([{ x: 0, y: 0, width: 0, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }], size), [{ x: 5, y: 5, width: 10, height: 10 }]);
  assert.equal(shapeOf([{ x: 0, y: 0, width: 0, height: 0 }], size), undefined, 'nothing to draw is not an empty shape: Electron reads that as the whole window');
  assert.equal(shapeOf([{ x: 'a', y: 0, width: 1, height: 1 }], size), undefined);
  assert.equal(shapeOf(Array.from({ length: 9 }, () => ({ x: 0, y: 0, width: 1, height: 1 })), size), undefined);
  assert.equal(shapeOf('everything', size), undefined);
});

test('a window is still reachable while a 40-pixel square of it is on a screen', () => {
  const laptop = { x: 0, y: 0, width: 1440, height: 875 };
  const monitor = { x: 1440, y: 0, width: 2560, height: 1415 };
  assert.equal(reachable({ x: 1900, y: 400, width: 480, height: 330 }, [laptop, monitor]), true);
  assert.equal(reachable({ x: 1900, y: 400, width: 480, height: 330 }, [laptop]), false, 'its monitor was unplugged');
  assert.equal(reachable({ x: 1420, y: 400, width: 480, height: 330 }, [laptop]), false, 'a 20-pixel sliver is not enough to grab');
  assert.equal(reachable({ x: 1380, y: 845, width: 480, height: 330 }, [laptop]), false);
  assert.equal(reachable({ x: 1380, y: 800, width: 480, height: 330 }, [laptop]), true);
});

test('the tray has an item per computer on the screen, saying which need the person', () => {
  const items = trayComputers([
    { id: 'cmp_a', label: 'Claude Code · chat started 09:41', held: false },
    { id: 'cmp_b', label: 'Cursor · chat started 09:44', held: true, handoffId: 'hnd_1' },
    { id: 'cmp_c', label: 'Zed · chat started 09:50', held: false, waiting: 'Sign in to GitHub' },
  ]);
  assert.deepEqual(items, [
    { id: 'cmp_a', label: 'Claude Code · chat started 09:41' },
    { id: 'cmp_b', label: 'Cursor · chat started 09:44 · you have it' },
    { id: 'cmp_c', label: 'Zed · chat started 09:50 · waiting for you' },
  ]);
});

test('an update installs itself only on a build whose signature it is checked against', () => {
  const appUpdate = 'owner: Hotragn\nrepo: husk\nprovider: github\nupdaterCacheDirName: husk-desktop-updater\n';
  assert.equal(signedBuild('win32', { appUpdate }), false, 'unsigned: no publisher to check a new installer against');
  assert.equal(signedBuild('win32', { appUpdate: `${appUpdate}publisherName:\n  - Hotragn\n` }), true);
  const mac = 'Executable=/Applications/Husk.app/Contents/MacOS/Husk\nIdentifier=dev.husk.desktop\n';
  assert.equal(signedBuild('darwin', { codesign: `${mac}Signature=adhoc\n` }), false, 'an ad-hoc signature does not count');
  assert.equal(signedBuild('darwin', { codesign: `${mac}Authority=Developer ID Application: Ada Lovelace (ABCDE12345)\nAuthority=Apple Root CA\n` }), true);
  assert.equal(signedBuild('linux', { appUpdate: 'publisherName: x' }), false);
});

test("the Husk this app starts gets the person's own PATH, with what it had kept after it", () => {
  const launchd = '/usr/bin:/bin:/usr/sbin:/sbin';
  // What a zsh with a chatty profile prints.
  const printed = 'Welcome back!\n__HUSK_PATH__/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin__HUSK_PATH__';
  assert.equal(shellPath(printed, launchd), '/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(shellPath('', launchd), undefined, 'a shell that printed nothing');
  assert.equal(shellPath('__HUSK_PATH____HUSK_PATH__', launchd), undefined, 'an empty PATH');
  assert.equal(shellPath(undefined, launchd), undefined, 'a shell that failed');
});
