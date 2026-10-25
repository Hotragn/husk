// Computers on the screen: a small row of 3D computers in the bottom-right
// corner, one per computer a chat is using; one compact Computers window
// whose tabs are those computers, opened only when the person clicks one; and
// the notch at the top, where that window goes when it is minimized.
//
// The pages are the console's own views (apps/console/src/desktop), served by
// the shared Husk and signed in like the console. This file places their
// windows, tells every one of them the same state, and checks each request
// against the window that sent it: the corner row can only show a computer,
// the notch can open or dismiss the window, the window can switch its tab and
// work itself. Nothing a page sends reaches anything else.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, screen, shell } from 'electron';
import { appIconPaths, computersWindowBounds, desktopComputers, desktopUrl, dockBounds, external, notchOf, pillBounds, sameOrigin, toOpen } from './lib.mjs';

const PRELOAD = join(import.meta.dirname, 'preload.cjs');
const ID = /^cmp_[a-z0-9]{1,40}$/i;
// The window opens when the person clicks a computer, not by itself, unless they chose that (asked once, main.mjs).
const DEFAULTS = { onScreen: true, notch: true, autoOpen: false };
const MAC = process.platform === 'darwin';
// Linux cannot forward mouse moves through a click-through window, so there
// the corner row and the notch stay clickable over their whole (small) windows.
const FORWARDS = process.platform !== 'linux';
const webPreferences = { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false };

export class Computers {
  /**
   * @param {{ rec: () => { url: string, token?: string } | undefined, icon: string,
   *   onConsole: (id: string) => void, onRefresh: () => void, giveBack: (handoffId: string) => Promise<boolean> }} opts
   */
  constructor(opts) {
    this.opts = opts;
    /** The Computers window, once opened, and where it is. */
    this.win = undefined;
    this.ready = false;
    this.state = 'closed';
    this.pending = 'show';
    this.pinned = true;
    /** The tab the window shows. */
    this.active = undefined;
    /** Computers shown this run: with "open by itself" on, none opens twice. */
    this.seen = new Set();
    this.since = Date.now() - 60_000;
    this.overview = undefined;
    this.icons = {};
    this.iconsAsked = new Set();
    this.dock = undefined;
    this.pill = undefined;
    /** Overlays that have drawn a first frame. Shown before it, a transparent window flashes black. */
    this.drawn = new WeakSet();
    // Closing the window only hides it, except when the app itself is quitting (Cmd+Q, logout).
    this.quitting = false;
    app.on('before-quit', () => {
      this.quitting = true;
    });
    this.file = join(app.getPath('userData'), 'computers.json');
    this.settings = { ...DEFAULTS, ...readJson(this.file) };
    ipcMain.handle('husk:act', (event, msg) => this.act(event.sender, msg));
    ipcMain.on('husk:hello', (event) => {
      if (this.whose(event.sender)) event.sender.send('husk:state', this.snapshot());
    });
  }

  /** Change one setting (the tray's checkboxes) and remember it. */
  set(key, value) {
    this.settings[key] = value;
    writeJson(this.file, this.settings);
    if (key === 'onScreen' && !value) this.close();
    this.layout();
    this.broadcast();
  }

  /** Whether the shared Husk is answering: when it is not, the windows say so and clear their screens. */
  setConnected(on) {
    if (this.connected === on) return;
    this.connected = on;
    this.broadcast();
  }

  /** A new reading of GET /v1/overview. */
  update(overview) {
    if (!overview) return;
    this.overview = overview;
    if (this.settings.onScreen && this.settings.autoOpen) {
      const next = toOpen(overview, this.since, this.seen)[0];
      if (next) this.open(next, { focus: false });
    }
    if (this.active && !this.computers().some((c) => c.id === this.active)) this.active = undefined;
    this.findIcons();
    this.layout();
    this.broadcast();
  }

  computers() {
    return desktopComputers(this.overview, this.active, this.icons, this.connected !== false);
  }

  snapshot() {
    const notch = notchOf(process.platform, screen.getPrimaryDisplay());
    const computers = this.computers();
    const active = this.active ?? computers[0]?.id;
    return {
      computers,
      ...(active ? { active } : {}),
      window: this.state,
      pinned: this.pinned,
      connected: this.connected !== false,
      ...(notch ? { notch } : {}),
    };
  }

  broadcast() {
    const s = this.snapshot();
    for (const w of this.pages()) w.webContents.send('husk:state', s);
  }

  pages() {
    return [this.dock, this.pill, this.win].filter((w) => w && !w.isDestroyed());
  }

  /** Which of this app's windows sent a request, by its page's id; undefined for any other page. */
  whose(sender) {
    const is = (w) => w && !w.isDestroyed() && w.webContents.id === sender.id;
    if (is(this.dock)) return 'dock';
    if (is(this.pill)) return 'pill';
    if (is(this.win)) return 'window';
    return undefined;
  }

  known(id) {
    return typeof id === 'string' && ID.test(id) && this.computers().some((c) => c.id === id);
  }

  /** What a page asked for, if that page may ask it. */
  act(sender, msg) {
    const from = this.whose(sender);
    if (!from || !msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'interactive': {
        const w = from === 'dock' ? this.dock : from === 'pill' ? this.pill : undefined;
        if (w && typeof msg.on === 'boolean' && FORWARDS) w.setIgnoreMouseEvents(!msg.on, { forward: true });
        return;
      }
      case 'toggle':
        if (from === 'dock' && this.known(msg.id)) this.toggle(msg.id);
        return;
      case 'open':
        if (from === 'pill' && this.known(msg.id)) this.open(msg.id, { focus: true });
        return;
      case 'dismiss':
        if (from === 'pill') this.close();
        return;
      case 'select':
        if (from === 'window' && this.known(msg.id)) {
          this.active = msg.id;
          this.broadcast();
        }
        return;
      case 'window':
        if (from !== 'window') return;
        if (msg.op === 'close') void this.requestClose();
        else if (msg.op === 'minimize') this.minimize();
        else if (msg.op === 'maximize') this.maximize();
        else if (msg.op === 'pin') this.pin();
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

  /** Show the window on this computer's tab. */
  open(id, { focus }) {
    this.seen.add(id);
    this.active = id;
    if (!this.win || this.win.isDestroyed()) this.create();
    this.state = 'open';
    this.pending = focus ? 'show' : 'inactive';
    if (this.ready) {
      if (this.win.isMinimized()) this.win.restore();
      if (focus) {
        this.win.show();
        this.win.focus();
      } else this.win.showInactive();
    }
    this.layout();
    this.broadcast();
  }

  create() {
    const win = new BrowserWindow({
      ...computersWindowBounds(screen.getPrimaryDisplay().workArea),
      minWidth: 320,
      minHeight: 220,
      frame: false,
      show: false,
      title: 'Computers',
      icon: this.opts.icon,
      backgroundColor: '#ffffff',
      fullscreenable: false,
      webPreferences,
    });
    this.win = win;
    this.ready = false;
    win.setAlwaysOnTop(this.pinned, 'floating');
    guard(win, () => this.opts.rec()?.url);
    win.once('ready-to-show', () => {
      this.ready = true;
      if (this.state !== 'open') return;
      if (this.pending === 'show') win.show();
      else win.showInactive();
    });
    // The system's own minimize (a shortcut, the taskbar) goes to the notch too.
    win.on('minimize', () => {
      this.state = 'minimized';
      this.layout();
      this.broadcast();
    });
    win.on('restore', () => {
      if (this.state !== 'minimized') return;
      this.state = 'open';
      this.layout();
      this.broadcast();
    });
    // Windows signing out or shutting down: let the window close.
    win.on('session-end', () => {
      this.quitting = true;
    });
    // Closing hides: the computers keep running and stay in the corner.
    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      void this.requestClose();
    });
    const rec = this.opts.rec();
    if (rec) void win.loadURL(desktopUrl(rec, 'computers'));
  }

  minimize() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
    this.state = 'minimized';
    this.layout();
    this.broadcast();
  }

  /**
   * The person closing the window: while they hold a computer, ask first, so
   * one is not forgotten with its chat paused. Keeping it is the default:
   * giving it back hands the computer to the AI. The window hides either way.
   */
  async requestClose() {
    const held = this.computers().filter((c) => c.held && c.handoffId);
    if (held.length && this.win && !this.win.isDestroyed()) {
      const one = held.length === 1;
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'question',
        message: one ? `You still hold ${held[0].label}` : `You still hold ${held.length} computers`,
        detail: `${one ? 'Its chat stays' : 'Their chats stay'} paused until you give ${one ? 'it' : 'them'} back. You can also give it back from the tray.`,
        buttons: ['Give back', 'Keep holding'],
        defaultId: 1,
        cancelId: 1,
      });
      if (response === 0) for (const c of held) await this.opts.giveBack(c.handoffId);
    }
    this.close();
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
    this.state = 'closed';
    this.layout();
    this.broadcast();
  }

  maximize() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isMaximized()) {
      this.win.unmaximize();
      this.win.setAlwaysOnTop(this.pinned, 'floating');
    } else {
      // A maximized window on top of everything would be in the way of everything.
      this.win.setAlwaysOnTop(false);
      this.win.maximize();
    }
  }

  pin() {
    this.pinned = !this.pinned;
    if (this.win && !this.win.isDestroyed() && !this.win.isMaximized()) this.win.setAlwaysOnTop(this.pinned, 'floating');
    this.broadcast();
  }

  /** The corner's click: the tab already in front goes to the notch; anything else comes to the front. */
  toggle(id) {
    const front = this.state === 'open' && this.win && !this.win.isDestroyed() && this.win.isVisible() && this.win.isFocused();
    if (front && this.active === id) this.minimize();
    else this.open(id, { focus: true });
  }

  /** Husk restarted with a new token: every page signs in again. */
  reload() {
    const rec = this.opts.rec();
    if (!rec) return;
    if (this.win && !this.win.isDestroyed()) void this.win.loadURL(desktopUrl(rec, 'computers'));
    if (this.dock && !this.dock.isDestroyed()) void this.dock.loadURL(desktopUrl(rec, 'dock'));
    if (this.pill && !this.pill.isDestroyed()) void this.pill.loadURL(desktopUrl(rec, 'pill'));
  }

  /** The corner row while any computer is running; the notch while the window is minimized. */
  layout() {
    const display = screen.getPrimaryDisplay();
    const count = this.computers().length;
    if (this.settings.onScreen && count > 0) {
      this.dock ??= this.overlay('dock', false);
      this.dock.setBounds(dockBounds(display.workArea, count));
      if (!this.dock.isVisible() && this.drawn.has(this.dock)) reveal(this.dock);
    } else this.dock?.hide();

    if (this.settings.notch && this.state === 'minimized' && count > 0) {
      this.pill ??= this.overlay('pill', true);
      const bounds = pillBounds(display, count);
      this.pill.setBounds(bounds);
      if (!this.pill.isVisible() && this.drawn.has(this.pill)) {
        reveal(this.pill);
        // macOS keeps a window below the menu bar until it is shown at its level; then it may sit on top.
        this.pill.setBounds(bounds);
      }
    } else this.pill?.hide();
  }

  /** A transparent, click-through window over everything: the corner row, or the notch (`top`). */
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
    // On screen only once the page has drawn, and then wherever layout says it belongs.
    w.once('ready-to-show', () => {
      this.drawn.add(w);
      this.layout();
    });
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
    return which === 'dock' ? this.dock : which === 'pill' ? this.pill : this.win;
  }

  async capture(which, file) {
    const w = this.windowOf(which);
    if (!w || w.isDestroyed()) return false;
    // A page whose GPU process failed to start (a CI machine without a GPU, now and then) can
    // wait for its next frame forever: give up on the picture, not on the walk.
    const img = await Promise.race([w.webContents.capturePage(), new Promise((r) => setTimeout(r, 15_000))]);
    if (!img) return false;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, img.toPNG());
    return !img.isEmpty();
  }

  run(which, js) {
    const w = this.windowOf(which);
    if (!w || w.isDestroyed()) return Promise.resolve(undefined);
    // A page that stopped answering, or is loading again, answers nothing (after 10 s at most), so its checks fail instead of the walk.
    return Promise.race([w.webContents.executeJavaScript(js).catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))]);
  }
}

/**
 * Show an overlay without a black first frame. macOS puts a newly shown
 * transparent window's empty surface on screen for a frame before the page's
 * picture reaches it, even when the page drew while hidden, so there the
 * window goes on screen fully transparent and turns visible a moment later.
 */
function reveal(w) {
  if (!MAC) return w.showInactive();
  w.setOpacity(0);
  w.showInactive();
  setTimeout(() => {
    if (!w.isDestroyed()) w.setOpacity(1);
  }, 120);
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
