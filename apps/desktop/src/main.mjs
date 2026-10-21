// Husk for the desktop: the shared Husk, its console in a window, and a tray
// icon that says when a chat is waiting for you.
//
// The app carries its own copy of Husk and runs it with Electron's built-in
// Node, so neither the app nor the chat apps it connects need Node installed.
// It never edits a chat app's settings by itself: that happens on the
// console's Connect page, at the person's click.

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell } from 'electron';
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
const POLL_MS = 5000;
// `HUSK_DESKTOP_SMOKE=1`: start hidden, load the console on a panel that asks
// no provider anything, print what loaded, stop the Husk it started, and quit.
// CI and a quick local check use it; a person never sees it.
const SMOKE = process.env.HUSK_DESKTOP_SMOKE === '1';
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
  if (SMOKE) console.log(line);
}

let win;
let tray;
let rec;
let waiting = [];
let recovering;

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
        await askToStop(rec);
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
  const status = trayStatus(overview);
  for (const h of newlyWaiting(waiting, status.waiting)) {
    const n = new Notification({ title: 'Waiting for you', body: h.reason, icon: ICON });
    n.on('click', () => openWindow('handoffs'));
    n.show();
  }
  waiting = status.waiting;
  refreshTray(status);
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
  openWindow(SMOKE ? 'husks' : firstRun() ? 'connect' : undefined);
  await poll();
  setInterval(() => void poll(), POLL_MS);
}

if (process.argv.includes('--husk-mcp')) void runMcp();
else void startApp();
