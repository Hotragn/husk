import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { consoleUrl, daemonCommand, external, isNewer, launchFor, newlyWaiting, readDaemonRecord, runtimeBin, sameOrigin, trayStatus } from './lib.mjs';

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
