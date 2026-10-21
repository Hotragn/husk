// Husk for the desktop: the shared Husk, its console in a window, and a tray
// icon that says when a chat is waiting for you.
//
// The app carries its own copy of Husk and runs it with Electron's built-in
// Node (ELECTRON_RUN_AS_NODE), so neither the app nor the chat apps it
// connects need Node installed. It never edits a chat app's settings by
// itself: that happens on the console's Connect page, at the person's click.

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } from 'electron';
import {
  consoleUrl,
  external,
  huskHome,
  launchFor,
  newlyWaiting,
  readDaemonRecord,
  runtimeBin,
  sameOrigin,
  trayStatus,
} from './lib.mjs';

const ICON = join(import.meta.dirname, '..', 'assets', 'icon.png');
const POLL_MS = 5000;
// `HUSK_DESKTOP_SMOKE=1`: start hidden, load the console on a panel that asks
// no provider anything, print what loaded, stop the Husk it started, and quit.
// CI and a quick local check use it; a person never sees it.
const SMOKE = process.env.HUSK_DESKTOP_SMOKE === '1';

/** What the app did, in ~/.husk/desktop.log: a GUI app has no terminal to say it in. */
function log(line) {
  try {
    mkdirSync(huskHome(), { recursive: true });
    appendFileSync(join(huskHome(), 'desktop.log'), `${new Date().toISOString()} ${line}
`);
  } catch {
    // nowhere left to say it
  }
  if (SMOKE) console.log(line);
}
process.on('uncaughtException', (err) => log(`error: ${err.stack ?? err}`));
process.on('unhandledRejection', (err) => log(`error: ${err?.stack ?? err}`));

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let tray;
let rec;
let waiting = [];

/** A Husk that answers, started by this app if none does. */
async function ensureHusk() {
  const bin = runtimeBin({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  if (!existsSync(bin)) throw new Error(`the bundled Husk is missing at ${bin}`);
  const live = async () => {
    const r = readDaemonRecord();
    if (!r) return undefined;
    try {
      const res = await fetch(`${r.url}/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok ? r : undefined;
    } catch {
      return undefined;
    }
  };
  let found = await live();
  if (found) return found;

  mkdirSync(huskHome(), { recursive: true });
  const log = openSync(join(huskHome(), 'daemon.log'), 'a');
  try {
    spawn(process.execPath, [bin, '--daemon'], {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
      // The Husk it starts tells the Connect page to write this app's binary
      // into chat apps, instead of `npx`.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HUSK_LAUNCH: JSON.stringify(launchFor(process.execPath, bin)) },
    }).unref();
  } finally {
    closeSync(log);
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
        try {
          process.kill(rec.pid);
        } catch {
          // already gone
        }
        app.exit(seen.includes('Husk') ? 0 : 1);
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
      { type: 'separator' },
      { label: 'Quit (chats keep their computers)', click: () => app.exit(0) },
      {
        label: 'Quit and stop Husk',
        click: () => {
          try {
            process.kill(rec.pid);
          } catch {
            // already gone
          }
          app.exit(0);
        },
      },
    ]),
  );
}

async function poll() {
  let overview;
  try {
    const res = await fetch(`${rec.url}/v1/overview`, { headers: rec.token ? { authorization: `Bearer ${rec.token}` } : {} });
    if (res.ok) overview = await res.json();
  } catch {
    // Husk restarted or stopped: find it again next time.
    rec = readDaemonRecord() ?? rec;
  }
  const status = trayStatus(overview);
  for (const h of newlyWaiting(waiting, status.waiting)) {
    const n = new Notification({ title: 'Waiting for you', body: h.reason, icon: ICON });
    n.on('click', () => openWindow('handoffs'));
    n.show();
  }
  waiting = status.waiting;
  refreshTray(status);
}

app.on('second-instance', () => openWindow());
// Closing the window leaves Husk in the tray; chats keep their computers.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
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
  openWindow(SMOKE ? 'husks' : firstRun() ? 'connect' : undefined);
  await poll();
  setInterval(() => void poll(), POLL_MS);
});

