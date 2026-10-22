// Husk for the desktop: the shared Husk, its console in a window, each chat's
// computer in a small window of its own (computers.mjs), and a tray icon that
// says when a chat is waiting for you.
//
// The app carries its own copy of Husk and runs it with Electron's built-in
// Node, so neither the app nor the chat apps it connects need Node installed.
// It never edits a chat app's settings by itself: that happens on the
// console's Connect page, at the person's click.

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, screen, shell } from 'electron';
import { Computers } from './computers.mjs';
import {
  consoleUrl,
  daemonCommand,
  external,
  huskHome,
  isNewer,
  launchFor,
  newlyWaiting,
  readDaemonRecord,
  runtimeBin,
  sameOrigin,
  trayStatus,
} from './lib.mjs';

const ICON = join(import.meta.dirname, '..', 'assets', 'icon.png');
const POLL_MS = 2000;
// `HUSK_DESKTOP_SMOKE=1`: start hidden, load the console on a panel that asks
// no provider anything, put two made-up computers on the screen and check
// their windows, print what loaded, stop the Husk it started, and quit.
// `HUSK_DESKTOP_SMOKE=live`: attach to a running Husk, wait for a real chat's
// computer to open its window by itself, walk it, and quit, leaving Husk
// running (scripts/e2e-computers.mjs). Both write pictures to
// HUSK_DESKTOP_SHOTS when it is set. CI uses them; a person never sees either.
const SMOKE = process.env.HUSK_DESKTOP_SMOKE === '1';
const LIVE = process.env.HUSK_DESKTOP_SMOKE === 'live';
const SHOTS = process.env.HUSK_DESKTOP_SHOTS;
// CI machines have no GPU. The 3D row is the app's own page, so software WebGL is safe for it there.
if (SMOKE || LIVE) app.commandLine.appendSwitch('enable-unsafe-swiftshader');
const BIN = runtimeBin({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });

/** ~/.husk, owner-only, as the rest of Husk makes it. */
function home() {
  mkdirSync(huskHome(), { recursive: true, mode: 0o700 });
  return huskHome();
}

/** What the app did, in ~/.husk/desktop.log: a GUI app has no terminal to say it in. */
function log(line) {
  try {
    appendFileSync(join(home(), 'desktop.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // nowhere left to say it
  }
  if (SMOKE || LIVE) console.log(line);
}

let win;
let tray;
let rec;
let waiting = [];
let recovering;
let computers;

/** Version of the Husk this app carries. */
function bundledVersion() {
  try {
    return JSON.parse(readFileSync(join(dirname(BIN), '..', 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

async function health(r) {
  try {
    const res = await fetch(`${r.url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

async function askToStop(r) {
  const res = await fetch(`${r.url}/v1/shutdown`, {
    method: 'POST',
    headers: r.token ? { authorization: `Bearer ${r.token}` } : {},
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
  return res?.status === 202;
}

/** A Husk that answers, and is this app's version or newer, started by this app if needed. */
async function ensureHusk() {
  if (!existsSync(BIN)) throw new Error(`the bundled Husk is missing at ${BIN}`);
  const live = async () => {
    const r = readDaemonRecord();
    return r && (await health(r)) ? r : undefined;
  };
  let found = await live();
  const mine = bundledVersion();
  if (found && mine) {
    const theirs = (await health(found))?.version;
    // An older Husk (an earlier app, or an npx chat) steps aside for this one,
    // unless someone is mid-run or mid-handoff.
    if (theirs && isNewer(mine, theirs) && (await askToStop(found))) {
      for (let i = 0; i < 40 && (await live()); i++) await new Promise((r) => setTimeout(r, 250));
      found = undefined;
    }
  }
  if (found) return found;

  const fd = openSync(join(home(), 'daemon.log'), 'a', 0o600);
  try {
    const { command, args, env } = daemonCommand({ execPath: process.execPath, bin: BIN, env: process.env });
    spawn(command, args, {
      cwd: huskHome(),
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      // The Husk it starts tells the Connect page to write this app into chat
      // apps, instead of `npx`.
      env: { ...env, HUSK_LAUNCH: JSON.stringify(launchFor(process.execPath, BIN, process.env)) },
    }).unref();
  } finally {
    closeSync(fd);
  }
  for (let i = 0; i < 80 && !found; i++) {
    await new Promise((r) => setTimeout(r, 250));
    found = await live();
  }
  if (!found) throw new Error(`Husk did not start; see ${join(huskHome(), 'daemon.log')}`);
  return found;
}

/** First launch opens Connect; after that, Home. */
function firstRun() {
  const marker = join(app.getPath('userData'), 'first-run-done');
  if (existsSync(marker)) return false;
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(marker, new Date().toISOString());
  return true;
}

function openWindow(panel) {
  if (!rec) {
    new Notification({ title: 'Husk is still starting', body: 'Try again in a moment.' }).show();
    return;
  }
  if (win && !win.isDestroyed()) {
    if (panel) void win.webContents.executeJavaScript(`location.hash = '#/${panel}'`);
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Husk',
    icon: ICON,
    backgroundColor: '#14110f',
    show: !SMOKE,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const seen = await win.webContents.executeJavaScript(
          '[document.title, location.hash, document.body.innerText.slice(0, 160).split(/\\s+/).join(" ")].join(" | ")',
        );
        log(`SMOKE loaded ${seen.replace(/token=[0-9a-f]+/, 'token=<redacted>')}`);
        const placed = await smokeComputers();
        await askToStop(rec);
        app.exit(seen.includes('Husk') && placed ? 0 : 1);
      }, 3000);
    });
  }
  win.removeMenu();
  // The console only. Anything else opens in the default browser, if it is a web link at all.
  win.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, rec.url)) {
      event.preventDefault();
      if (external(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (external(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void win.loadURL(consoleUrl(rec, panel));
}

function refreshTray(status) {
  const atLogin = app.getLoginItemSettings().openAtLogin;
  tray.setToolTip(`Husk · ${status.label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status.label, enabled: false },
      ...status.waiting.map((h) => ({ label: `Take over: ${h.reason.slice(0, 60)}`, click: () => openWindow('handoffs') })),
      { type: 'separator' },
      { label: 'Open Husk', click: () => openWindow() },
      { label: 'Connect chat apps', click: () => openWindow('connect') },
      { label: 'Start at login', type: 'checkbox', checked: atLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      ...(computers
        ? [
            { type: 'separator' },
            { label: 'Show computers on screen', type: 'checkbox', checked: computers.settings.onScreen, click: (item) => computers.set('onScreen', item.checked) },
            { label: 'Open a computer when a chat starts using it', type: 'checkbox', checked: computers.settings.autoOpen, click: (item) => computers.set('autoOpen', item.checked) },
            { label: 'Minimize computers to the notch', type: 'checkbox', checked: computers.settings.notch, click: (item) => computers.set('notch', item.checked) },
          ]
        : []),
      { type: 'separator' },
      { label: 'Quit (chats keep their computers)', click: () => app.exit(0) },
      {
        label: 'Quit and stop Husk',
        click: async () => {
          // Asked, never killed: a pid in a file may belong to something else
          // by now, and a clean stop flushes Husk's records.
          if (rec && !(await askToStop(rec))) {
            dialog.showErrorBox('Husk is busy', 'A run or a handoff is in progress, so Husk was left running. Quit again when it finishes.');
            return;
          }
          app.exit(0);
        },
      },
    ]),
  );
}

/** Husk restarted (new token) or stopped: find it, or start it, and point the window at it. */
async function recover() {
  recovering ??= (async () => {
    const next = readDaemonRecord();
    const fresh = next && (await health(next)) ? next : await ensureHusk().catch((err) => {
      log(`Husk could not be restarted: ${err.message}`);
      return undefined;
    });
    if (fresh && (fresh.pid !== rec?.pid || fresh.token !== rec?.token)) {
      rec = fresh;
      if (win && !win.isDestroyed()) void win.loadURL(consoleUrl(rec));
      computers?.reload();
    }
  })().finally(() => {
    recovering = undefined;
  });
  return recovering;
}

async function poll() {
  let overview;
  try {
    const res = await fetch(`${rec.url}/v1/overview`, { headers: rec.token ? { authorization: `Bearer ${rec.token}` } : {} });
    if (res.ok) overview = await res.json();
    else if (res.status === 401) await recover();
  } catch {
    await recover();
  }
  // The made-up computers of a smoke run are not in Husk: a reading would take them off the screen.
  if (overview && !SMOKE) computers?.update(overview);
  const status = trayStatus(overview);
  for (const h of newlyWaiting(waiting, status.waiting)) {
    const n = new Notification({ title: 'Waiting for you', body: h.reason, icon: ICON });
    n.on('click', () => (h.computerId && computers?.settings.onScreen ? computers.open(h.computerId, { focus: true }) : openWindow('handoffs')));
    n.show();
  }
  waiting = status.waiting;
  refreshTray(status);
}

// -- smoke runs ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first truthy answer of `fn`, asked every quarter second, or undefined after `ms`. */
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return undefined;
}

function checker() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(Boolean(ok));
    log(`SMOKE ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  };
  return { check, passed: () => results.every(Boolean) };
}

const inside = (b, area) => b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;

/** Put the computers on the screen and look at them: the window, the 3D row, the notch. */
async function walkComputers(check, id, prefix) {
  const area = screen.getPrimaryDisplay().workArea;
  const window = computers.windows.get(id)?.win;
  check('the computer window opens inside the screen', window && inside(window.getBounds(), area), JSON.stringify(window?.getBounds()));
  await sleep(2500); // the 3D row builds and its screens fill
  const dock = computers.dock?.getBounds();
  check('the row of 3D computers sits in the bottom-right corner', dock && inside(dock, area) && dock.x + dock.width > area.x + area.width - 40, JSON.stringify(dock));
  const mode = await computers.run('dock', `document.querySelector('.dock-flat') ? 'flat' : '3D'`);
  const slots = await computers.run('dock', `document.querySelectorAll('.dock-slot').length`);
  check('the row stands a computer per chat', slots > 0, `${slots} in ${mode}`);
  if (SHOTS) {
    await computers.capture(id, join(SHOTS, `${prefix}-window.png`));
    await computers.capture('dock', join(SHOTS, `${prefix}-dock.png`));
  }
  await computers.run('dock', `document.querySelector('.dock-hit')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  const tip = await until(() => computers.run('dock', `document.querySelector('.dock-tip')?.textContent ?? ''`), 3000);
  check('hovering a 3D computer names its chat', /started/.test(tip ?? ''), tip);
  if (SHOTS) await computers.capture('dock', join(SHOTS, `${prefix}-dock-hover.png`));
  await computers.run('dock', `document.querySelector('.dock-hit')?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))`);

  computers.minimize(id);
  const logos = await until(() => computers.run('pill', `document.querySelectorAll('.pill-logo').length`), 8000);
  check('minimizing sends the window to the notch', logos >= 1, `${logos} in the notch`);
  const pill = computers.pill?.getBounds();
  const display = screen.getPrimaryDisplay().bounds;
  check(
    'the notch hangs from the top centre of the screen',
    pill && pill.y === display.y && Math.abs(pill.x + pill.width / 2 - (display.x + display.width / 2)) <= 1,
    JSON.stringify(pill),
  );
  if (SHOTS) await computers.capture('pill', join(SHOTS, `${prefix}-notch.png`));
  await computers.run('pill', `document.querySelector('.pill')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  const rows = await until(() => computers.run('pill', `document.querySelectorAll('.pill-row').length`), 3000);
  check('the notch opens into a list on hover', rows >= 1, `${rows} rows`);
  await sleep(400);
  if (SHOTS) await computers.capture('pill', join(SHOTS, `${prefix}-notch-open.png`));
  computers.open(id, { focus: true });
  await sleep(600);
  check('opening it from the notch brings the window back', computers.windows.get(id)?.win.isVisible() === true);
}

/** HUSK_DESKTOP_SMOKE=1: two made-up chats' computers, one of them waiting for the person. */
async function smokeComputers() {
  const { check, passed } = checker();
  const at = new Date().toISOString();
  const made = (id, platform, minute) => ({ id, name: id, state: 'running', provider: 'docker', image: 'x', workdir: '/work', createdAt: at, lastUsedAt: at, platform, chatLabel: `${platform} · chat started 09:${minute}` });
  computers.since = 0;
  computers.update({
    computers: [made('cmp_smokea1', 'Claude Code', '41'), made('cmp_smokeb2', 'Claude Desktop', '44')],
    activeRuns: [],
    handoffs: [{ handoffId: 'hnd_smoke', runId: 'chat', husk: 'chat', reason: 'Sign in to GitHub', computerId: 'cmp_smokeb2', createdAt: at }],
    activity: {
      cmp_smokea1: { at, tool: 'browser_goto', ok: true, ms: 61, via: 'mcp', summary: 'https://example.com' },
      cmp_smokeb2: { at, tool: 'hand_off', ok: true, ms: 12, via: 'mcp' },
    },
  });
  const opened = await until(() => computers.windows.get('cmp_smokea1')?.ready, 20_000);
  check('a chat’s computer opens a window by itself', opened);
  const shown = await until(() => computers.run('cmp_smokea1', `document.querySelector('.cw-name')?.textContent ?? ''`), 10_000);
  check('the window names its chat', shown === 'Claude Code · chat started 09:41', shown);
  if (opened) await walkComputers(check, 'cmp_smokea1', 'desktop');
  return passed();
}

/** HUSK_DESKTOP_SMOKE=live: a real chat's computer, on a real Husk. */
async function liveSmoke() {
  const { check, passed } = checker();
  computers.since = Date.now();
  setInterval(() => void poll(), 1000);
  log('SMOKE live ready');
  const id = await until(() => [...computers.windows.entries()].find(([, r]) => r.ready && r.state === 'open')?.[0], 90_000);
  check('a chat’s computer opens a window by itself', id, id);
  if (id) {
    const width = await until(
      () => computers.run(id, `(() => { const i = document.querySelector('.cw-screen img'); return i && i.naturalWidth > 0 ? i.naturalWidth : 0; })()`),
      30_000,
    );
    check('the window shows the computer’s browser live', width, `${width}px wide`);
    const tabs = await until(() => computers.run(id, `[...document.querySelectorAll('.cw-tab')].map((t) => t.textContent).join(' | ')`), 10_000);
    check('the window names the browser’s tabs', tabs, tabs);
    await walkComputers(check, id, 'live');
  }
  app.exit(passed() ? 0 : 1);
}

/**
 * `Husk --husk-mcp [args]`: be the MCP server a chat app starts. The Linux
 * AppImage needs this: it mounts itself somewhere new on every run, so a chat
 * app cannot be pointed at a file inside it, only at the AppImage itself.
 */
async function runMcp() {
  const at = process.argv.indexOf('--husk-mcp');
  process.argv = [process.execPath, BIN, ...process.argv.slice(at + 1)];
  app.dock?.hide();
  await import(pathToFileURL(BIN).href);
}

async function startApp() {
  process.on('uncaughtException', (err) => log(`error: ${err.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`error: ${err?.stack ?? err}`));
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on('second-instance', () => openWindow());
  // Closing the window leaves Husk in the tray; chats keep their computers.
  app.on('window-all-closed', () => {});

  await app.whenReady();
  // A Mac app run from the disk image or from Downloads gets a path that goes
  // away, and chat apps would be pointed at it. Move it first.
  if (process.platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder() && !SMOKE) {
    const { response } = await dialog.showMessageBox({
      message: 'Move Husk to your Applications folder?',
      detail: 'Your chat apps start Husk from where it is installed, so it needs a place that stays put.',
      buttons: ['Move to Applications', 'Not now'],
    });
    if (response === 0 && app.moveToApplicationsFolder()) return;
    log('running outside Applications; chat apps connected from here may lose Husk when it moves');
  }
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', () => openWindow());
  refreshTray(trayStatus(undefined));
  try {
    rec = await ensureHusk();
  } catch (err) {
    log(`Husk could not start: ${err.stack ?? err}`);
    tray.setToolTip(`Husk could not start: ${err.message}`);
    new Notification({ title: 'Husk could not start', body: err.message }).show();
    return;
  }
  computers = new Computers({ rec: () => rec, icon: ICON, onConsole: () => openWindow(), onRefresh: () => void poll() });
  if (LIVE) {
    void liveSmoke();
    return;
  }
  openWindow(SMOKE ? 'husks' : firstRun() ? 'connect' : undefined);
  await poll();
  setInterval(() => void poll(), POLL_MS);
}

if (process.argv.includes('--husk-mcp')) void runMcp();
else void startApp();
