// Computers on the screen: a small live window for each computer a chat uses,
// the row of 3D computers in the bottom-right corner, and the notch at the top
// where a minimized window goes.
//
// The pages are the console's own views (apps/console/src/desktop), served by
// the shared Husk and signed in like the console. This file places their
// windows, tells every one of them the same state, and checks each request
// against the window that sent it: a computer window can only work its own
// window, the dock can only show and hide windows, the notch can open and
// close them. Nothing a page sends reaches anything else.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BrowserWindow, app, ipcMain, screen, shell } from 'electron';
import { appIconPaths, computerWindowBounds, desktopComputers, desktopUrl, dockBounds, external, notchOf, pillBounds, sameOrigin, toOpen } from './lib.mjs';

const PRELOAD = join(import.meta.dirname, 'preload.cjs');
const ID = /^cmp_[a-z0-9]{1,40}$/i;
const DEFAULTS = { onScreen: true, notch: true, autoOpen: true };
const MAC = process.platform === 'darwin';
// Linux cannot forward mouse moves through a click-through window, so there
// the dock and the notch stay clickable over their whole (small) windows.
const FORWARDS = process.platform !== 'linux';
const webPreferences = { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false };

export class Computers {
  /**
   * @param {{ rec: () => { url: string, token?: string } | undefined, icon: string,
   *   onConsole: (id: string) => void, onRefresh: () => void }} opts
   */
  constructor(opts) {
    this.opts = opts;
    /** id -> { win, state: 'open' | 'minimized' | 'closed', pinned, ready, pending } */
    this.windows = new Map();
    /** Computers that have had a window this run: none opens by itself twice. */
    this.seen = new Set();
    this.since = Date.now() - 60_000;
    this.waitingShown = new Set();
    this.overview = undefined;
    this.icons = {};
    this.iconsAsked = new Set();
    this.dock = undefined;
    this.pill = undefined;
    // Closing a computer window only hides it, except when the app itself is quitting (Cmd+Q, logout).
    this.quitting = false;
    app.on('before-quit', () => {
      this.quitting = true;
    });
    this.file = join(app.getPath('userData'), 'computers.json');
    this.settings = { ...DEFAULTS, ...readJson(this.file) };
    ipcMain.handle('husk:act', (event, msg) => this.act(event.sender, msg));
    ipcMain.on('husk:hello', (event) => {
      if (this.whose(event.sender)) event.sender.send('husk:state', this.state());
    });
  }

  /** Change one setting (the tray's checkboxes) and remember it. */
  set(key, value) {
    this.settings[key] = value;
    writeJson(this.file, this.settings);
    if (key === 'onScreen' && !value) for (const id of this.windows.keys()) this.close(id);
    this.layout();
    this.broadcast();
  }

  /** A new reading of GET /v1/overview. */
  update(overview) {
    if (!overview) return;
    this.overview = overview;
    const live = new Set(overview.computers.filter((c) => c.state !== 'destroyed').map((c) => c.id));
    for (const id of [...this.windows.keys()]) if (!live.has(id)) this.destroy(id);
    if (this.settings.onScreen) {
      if (this.settings.autoOpen) for (const id of toOpen(overview, this.since, this.seen)) this.open(id, { focus: false });
      // A chat that asks for the person brings its window back, without taking the keyboard.
      for (const h of overview.handoffs ?? []) {
        if (h.runId === 'person' || !h.computerId || !live.has(h.computerId) || this.waitingShown.has(h.handoffId)) continue;
        this.waitingShown.add(h.handoffId);
        this.open(h.computerId, { focus: false });
      }
    }
    this.findIcons();
    this.layout();
    this.broadcast();
  }

  state() {
    const notch = notchOf(process.platform, screen.getPrimaryDisplay());
    return { computers: desktopComputers(this.overview, this.windows, this.icons), ...(notch ? { notch } : {}) };
  }

  broadcast() {
    const s = this.state();
    for (const w of this.pages()) w.webContents.send('husk:state', s);
  }

  pages() {
    return [this.dock, this.pill, ...[...this.windows.values()].map((r) => r.win)].filter((w) => w && !w.isDestroyed());
  }

  /** Which of this app's windows sent a request, by its page's id; undefined for any other page. */
  whose(sender) {
    const is = (w) => w && !w.isDestroyed() && w.webContents.id === sender.id;
    if (is(this.dock)) return { kind: 'dock' };
    if (is(this.pill)) return { kind: 'pill' };
    for (const [id, r] of this.windows) if (is(r.win)) return { kind: 'computer', id };
    return undefined;
  }

  known(id) {
    return typeof id === 'string' && ID.test(id) && Boolean(this.overview?.computers.some((c) => c.id === id && c.state !== 'destroyed'));
  }

  /** What a page asked for, if that page may ask it. */
  act(sender, msg) {
    const from = this.whose(sender);
    if (!from || !msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'interactive': {
        const w = from.kind === 'dock' ? this.dock : from.kind === 'pill' ? this.pill : undefined;
        if (w && typeof msg.on === 'boolean' && FORWARDS) w.setIgnoreMouseEvents(!msg.on, { forward: true });
        return;
      }
      case 'toggle':
        if (from.kind === 'dock' && this.known(msg.id)) this.toggle(msg.id);
        return;
      case 'open':
        if (from.kind !== 'computer' && this.known(msg.id)) this.open(msg.id, { focus: true });
        return;
      case 'close':
        if (from.kind === 'pill' && this.known(msg.id)) this.close(msg.id);
        return;
      case 'window':
        if (from.kind !== 'computer') return;
        if (msg.op === 'close') this.close(from.id);
        else if (msg.op === 'minimize') this.minimize(from.id);
        else if (msg.op === 'maximize') this.maximize(from.id);
        else if (msg.op === 'pin') this.pin(from.id);
        return;
      case 'console':
        if (this.known(msg.id)) this.opts.onConsole(msg.id);
        return;
      case 'refresh':
        this.opts.onRefresh();
        return;
      default:
    }
  }

  open(id, { focus }) {
    this.seen.add(id);
    let r = this.windows.get(id);
    if (!r || r.win.isDestroyed()) r = this.create(id);
    r.state = 'open';
    r.pending = focus ? 'show' : 'inactive';
    if (r.ready) {
      if (r.win.isMinimized()) r.win.restore();
      if (focus) {
        r.win.show();
        r.win.focus();
      } else r.win.showInactive();
    }
    this.layout();
    this.broadcast();
  }

  create(id) {
    const open = [...this.windows.values()].filter((w) => w.state !== 'closed').length;
    const c = this.overview?.computers.find((x) => x.id === id);
    const win = new BrowserWindow({
      ...computerWindowBounds(screen.getPrimaryDisplay().workArea, open),
      minWidth: 340,
      minHeight: 240,
      frame: false,
      show: false,
      title: c?.chatLabel ?? 'Husk computer',
      icon: this.opts.icon,
      backgroundColor: '#0a0a0c',
      fullscreenable: false,
      webPreferences,
    });
    const r = { win, state: 'open', pinned: true, ready: false, pending: 'inactive' };
    win.setAlwaysOnTop(true, 'floating');
    guard(win, () => this.opts.rec()?.url);
    win.once('ready-to-show', () => {
      r.ready = true;
      if (r.state !== 'open') return;
      if (r.pending === 'show') win.show();
      else win.showInactive();
    });
    // The system's own minimize (a shortcut, the taskbar) counts as to the notch too.
    win.on('minimize', () => {
      r.state = 'minimized';
      this.layout();
      this.broadcast();
    });
    win.on('restore', () => {
      if (r.state !== 'minimized') return;
      r.state = 'open';
      this.layout();
      this.broadcast();
    });
    // Windows signing out or shutting down: let the windows close.
    win.on('session-end', () => {
      this.quitting = true;
    });
    // Closing hides: the computer keeps running and its 3D computer stays.
    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.close(id);
    });
    const rec = this.opts.rec();
    if (rec) void win.loadURL(desktopUrl(rec, 'computer', id));
    this.windows.set(id, r);
    return r;
  }

  minimize(id) {
    const r = this.windows.get(id);
    if (!r) return;
    r.win.hide();
    r.state = 'minimized';
    this.layout();
    this.broadcast();
  }

  close(id) {
    const r = this.windows.get(id);
    if (!r) return;
    r.win.hide();
    r.state = 'closed';
    this.layout();
    this.broadcast();
  }

  maximize(id) {
    const r = this.windows.get(id);
    if (!r) return;
    if (r.win.isMaximized()) {
      r.win.unmaximize();
      r.win.setAlwaysOnTop(r.pinned, 'floating');
    } else {
      // A maximized window on top of everything would be in the way of everything.
      r.win.setAlwaysOnTop(false);
      r.win.maximize();
    }
  }

  pin(id) {
    const r = this.windows.get(id);
    if (!r) return;
    r.pinned = !r.pinned;
    if (!r.win.isMaximized()) r.win.setAlwaysOnTop(r.pinned, 'floating');
    this.broadcast();
  }

  /** The dock's click: a window in front goes to the notch; anything else comes to the front. */
  toggle(id) {
    const r = this.windows.get(id);
    if (r && r.state === 'open' && r.win.isVisible() && r.win.isFocused()) this.minimize(id);
    else this.open(id, { focus: true });
  }

  destroy(id) {
    const r = this.windows.get(id);
    this.windows.delete(id);
    if (r && !r.win.isDestroyed()) r.win.destroy();
  }

  /** Husk restarted with a new token: every page signs in again. */
  reload() {
    const rec = this.opts.rec();
    if (!rec) return;
    for (const [id, r] of this.windows) if (!r.win.isDestroyed()) void r.win.loadURL(desktopUrl(rec, 'computer', id));
    if (this.dock && !this.dock.isDestroyed()) void this.dock.loadURL(desktopUrl(rec, 'dock'));
    if (this.pill && !this.pill.isDestroyed()) void this.pill.loadURL(desktopUrl(rec, 'pill'));
  }

  /** The dock while any computer stands in it; the notch while anything is minimized. */
  layout() {
    const display = screen.getPrimaryDisplay();
    const list = desktopComputers(this.overview, this.windows);
    const standing = list.filter((c) => c.state === 'running' || c.window !== 'closed').length;
    if (this.settings.onScreen && standing > 0) {
      this.dock ??= this.overlay('dock', false);
      this.dock.setBounds(dockBounds(display.workArea, standing));
      if (!this.dock.isVisible()) this.dock.showInactive();
    } else this.dock?.hide();

    const minimized = list.filter((c) => c.window === 'minimized').length;
    if (this.settings.notch && minimized > 0) {
      this.pill ??= this.overlay('pill', true);
      const bounds = pillBounds(display, minimized);
      this.pill.setBounds(bounds);
      if (!this.pill.isVisible()) {
        this.pill.showInactive();
        // macOS keeps a window below the menu bar until it is shown at its level; then it may sit on top.
        this.pill.setBounds(bounds);
      }
    } else this.pill?.hide();
  }

  /** A transparent, click-through window over everything: the dock, or the notch (`top`). */
  overlay(view, top) {
    const w = new BrowserWindow({
      width: 10,
      height: 10,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      ...(MAC ? { type: 'panel', hiddenInMissionControl: true } : {}),
      ...(top ? { enableLargerThanScreen: true } : {}),
      webPreferences,
    });
    w.setAlwaysOnTop(true, top ? 'screen-saver' : 'floating');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: top });
    if (FORWARDS) w.setIgnoreMouseEvents(true, { forward: true });
    guard(w, () => this.opts.rec()?.url);
    const rec = this.opts.rec();
    if (rec) void w.loadURL(desktopUrl(rec, view));
    return w;
  }

  /** The chat apps' own icons, read once each from where they are installed. */
  findIcons() {
    for (const c of this.overview?.computers ?? []) {
      const p = c.platform;
      if (!p || this.iconsAsked.has(p)) continue;
      this.iconsAsked.add(p);
      const file = appIconPaths(p, process.platform, process.env).find((f) => existsSync(f));
      if (!file) continue;
      app.getFileIcon(file, { size: 'normal' }).then(
        (img) => {
          if (img.isEmpty()) return;
          this.icons[p] = img.toDataURL();
          this.broadcast();
        },
        () => undefined,
      );
    }
  }

  // -- smoke tests: what CI looks at ------------------------------------------

  windowOf(which) {
    return which === 'dock' ? this.dock : which === 'pill' ? this.pill : this.windows.get(which)?.win;
  }

  async capture(which, file) {
    const w = this.windowOf(which);
    if (!w || w.isDestroyed()) return false;
    const img = await w.webContents.capturePage();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, img.toPNG());
    return !img.isEmpty();
  }

  run(which, js) {
    const w = this.windowOf(which);
    return w && !w.isDestroyed() ? w.webContents.executeJavaScript(js) : Promise.resolve(undefined);
  }
}

/** The page stays on Husk's own origin; any other web link opens in the default browser. */
function guard(win, origin) {
  win.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url, origin() ?? '')) return;
    event.preventDefault();
    if (external(url)) void shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (external(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
  } catch {
    // a setting not remembered is still a setting for this run
  }
}
