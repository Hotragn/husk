// The desktop app's decisions, kept apart from Electron so `node --test` can
// check them without starting a window.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';

/**
 * Where the bundled Husk lives. A packaged app carries it in its resources;
 * from a checkout it is the monorepo's own build.
 */
export function runtimeBin({ isPackaged, resourcesPath, appPath }) {
  return isPackaged
    ? join(resourcesPath, 'runtime', 'node_modules', '@husk-ai', 'mcp', 'dist', 'bin.js')
    : resolve(appPath, '..', '..', 'packages', 'mcp', 'dist', 'bin.js');
}

/**
 * How a chat app starts this install's Husk: the app's own binary, run as
 * Node, on the bundled bin.js. Nothing for the person to install. A Linux
 * AppImage mounts itself at a new path on every run, so there the chat app
 * starts the AppImage itself with `--husk-mcp`.
 */
export function launchFor(execPath, bin, env = {}) {
  if (env.APPIMAGE) return { command: env.APPIMAGE, args: ['--husk-mcp'] };
  return { command: execPath, args: [bin], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** How the app starts the shared Husk so it outlives the app (and, on Linux, its mount). */
export function daemonCommand({ execPath, bin, env }) {
  if (env.APPIMAGE) {
    const { ELECTRON_RUN_AS_NODE: _drop, ...rest } = env;
    return { command: env.APPIMAGE, args: ['--husk-mcp', '--daemon'], env: rest };
  }
  return { command: execPath, args: [bin, '--daemon'], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

/** a > b for x.y.z versions. */
export function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export function huskHome(env = process.env) {
  return env.HUSK_HOME ? resolve(env.HUSK_HOME) : join(homedir(), '.husk');
}

/** ~/.husk/daemon.json, written by the running Husk, or undefined. */
export function readDaemonRecord(env = process.env) {
  try {
    const rec = JSON.parse(readFileSync(join(huskHome(env), 'daemon.json'), 'utf8'));
    return typeof rec.url === 'string' && typeof rec.pid === 'number' ? rec : undefined;
  } catch {
    return undefined;
  }
}

/** The console, signed in with the daemon's token, on a panel. */
export function consoleUrl(rec, panel) {
  const token = rec.token ? `token=${encodeURIComponent(rec.token)}` : '';
  return panel ? `${rec.url}/#${token}${token ? '&' : ''}panel=${panel}` : `${rec.url}/#${token}`;
}

/** Only the console's own origin opens inside the window. */
export function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** Links that may leave for the default browser: http and https only. */
export function external(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** The tray's one line, what waits for the person, and what they hold, from GET /v1/overview. */
export function trayStatus(overview, answering = true) {
  // Not answering is not starting: say which, so a person knows to wait or to look.
  if (!answering) return { label: 'Husk is not answering · trying again', waiting: [], held: [] };
  if (!overview) return { label: 'Husk is starting', waiting: [], held: [] };
  const running = overview.computers.filter((c) => c.state === 'running').length;
  const handoffs = overview.handoffs ?? [];
  // A computer the person took is not waiting on them: it is theirs, and its chat is paused until they give it back.
  const waiting = handoffs.filter((h) => h.runId !== 'person');
  const held = handoffs
    .filter((h) => h.runId === 'person')
    .map((h) => {
      const c = overview.computers.find((x) => x.id === h.computerId);
      return { handoffId: h.handoffId, label: c?.chatLabel ?? c?.name ?? h.computerId ?? h.handoffId };
    });
  const parts = [`${running} computer${running === 1 ? '' : 's'} running`];
  if (held.length) parts.push(`you hold ${held.length}`);
  if (waiting.length) parts.push(`${waiting.length} waiting for you`);
  return { label: parts.join(' · '), waiting, held };
}

/**
 * How long to wait before starting the shared Husk again, after waiting
 * `previous` ms the last time: two seconds, doubling to a minute. Finding a Husk
 * someone else started is not held back, only starting one: a Husk that dies
 * as it starts must not be started again every second.
 */
export function restartDelay(previous) {
  return previous ? Math.min(previous * 2, 60_000) : 2_000;
}

/**
 * Whether this build is signed the way an update's signature is checked
 * against it: on Windows its app-update.yml names the certificate's
 * publisher, which a downloaded installer must match; on a Mac `codesign -dv`
 * names a Developer ID, which Squirrel checks a new version against. An
 * ad-hoc signature does not count, and Linux has none.
 */
export function signedBuild(platform, { appUpdate = '', codesign = '' } = {}) {
  if (platform === 'win32') return /^publisherName:/m.test(appUpdate);
  if (platform === 'darwin') return /^Authority=Developer ID Application: /m.test(codesign);
  return false;
}

/** Marks the PATH in what a login shell prints, around whatever its profile prints too. */
export const PATH_MARK = '__HUSK_PATH__';

/**
 * The PATH a person's login shell gave, from what it printed, put before the
 * one this app was started with, and without repeats. A Mac app opened from
 * the Finder gets launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, without Homebrew,
 * the Docker CLI, or the person's claude and codex. Undefined when the shell
 * said nothing usable.
 */
export function shellPath(printed, current = '', delimiter = ':') {
  const found = new RegExp(`${PATH_MARK}(.*?)${PATH_MARK}`).exec(printed ?? '')?.[1];
  if (!found?.includes('/')) return undefined;
  return [...new Set([...found.split(delimiter), ...current.split(delimiter)].filter(Boolean))].join(delimiter);
}

/** The tray's item for each computer on the screen, which opens its window: its chat, and whether it needs the person. */
export function trayComputers(list) {
  return list.map((c) => ({ id: c.id, label: `${c.label}${c.held ? ' · you have it' : c.waiting ? ' · waiting for you' : ''}` }));
}

/** Handoffs that were not waiting last time: one notification each. */
export function newlyWaiting(before, after) {
  const seen = new Set(before.map((h) => h.handoffId));
  return after.filter((h) => !seen.has(h.handoffId));
}

// -- computers on the screen ------------------------------------------------

/** One computer's place in the corner row, in screen points: small, so it never distracts. Dock.tsx uses the same. */
export const SLOT_W = 44;
export const SLOT_H = 46;
/** Room above the row for its small hover label, and to its left for a long one. */
const TIP_H = 30;
const TIP_W = 110;
const EDGE = 12;

/** A desktop window's page: one of the console's own small views, signed in like the console. */
export function desktopUrl(rec, view) {
  const token = rec.token ? `token=${encodeURIComponent(rec.token)}&` : '';
  return `${rec.url}/#${token}view=${view}`;
}

/** The corner row: the bottom-right of the work area, one small slot per computer. */
export function dockBounds(workArea, count) {
  const width = Math.max(1, count) * SLOT_W + TIP_W;
  const height = SLOT_H + TIP_H;
  return { x: workArea.x + workArea.width - width - EDGE, y: workArea.y + workArea.height - height - EDGE / 2, width, height };
}

/** The Computers window: compact, bottom-right, just above the corner row. */
export function computersWindowBounds(workArea, size = { width: 480, height: 330 }) {
  const x = workArea.x + workArea.width - size.width - EDGE;
  const y = workArea.y + workArea.height - size.height - SLOT_H - 2 * EDGE;
  return { x: Math.max(workArea.x, x), y: Math.max(workArea.y, y), ...size };
}

/** The notch's window: centred on the display's top edge, tall enough to open into a list of `rows`. */
export function pillBounds(display, rows) {
  const width = 420;
  const height = Math.min(360, 64 + Math.max(1, rows) * 46);
  return { x: Math.round(display.bounds.x + (display.bounds.width - width) / 2), y: display.bounds.y, width, height };
}

/**
 * Where a corner or notch page says it draws, as `setShape` takes it: at most
 * eight whole-pixel boxes, each cut to the window's own `size`, and none that
 * is empty. Undefined when the page sent anything else, or nothing to draw.
 */
export function shapeOf(rects, size) {
  if (!Array.isArray(rects) || rects.length > 8 || !size) return undefined;
  const out = [];
  for (const r of rects) {
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) return undefined;
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const width = Math.min(size.width, Math.ceil(r.x + r.width)) - x;
    const height = Math.min(size.height, Math.ceil(r.y + r.height)) - y;
    if (width > 0 && height > 0) out.push({ x, y, width, height });
  }
  return out.length ? out : undefined;
}

/** Whether a person can still reach a window at `bounds`: a 40-pixel square of it on one of the screens' work `areas`. */
export function reachable(bounds, areas) {
  return areas.some((a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= 40 && h >= 40;
  });
}

/** A Mac whose menu bar is notch-tall has a notch: the pill wraps it. Elsewhere it hangs alone. */
export function notchOf(platform, display) {
  const bar = display.workArea.y - display.bounds.y;
  return platform === 'darwin' && bar >= 30 ? { gap: 200, height: bar } : undefined;
}

/** Providers whose screen is a pushed screencast, which never counts as using the computer. */
export const PUSHED_SCREEN = new Set(['docker', 'podman', 'local']);

/**
 * The computers on the screen, from GET /v1/overview: every running one (the
 * corner row, and the Computers window's tabs), and the tab being shown even
 * once it stops. Each says who holds it and what it last did, and what it is
 * running now, unless Husk is not `answering`: then nothing is known to be running.
 */
export function desktopComputers(overview, active, icons = {}, answering = true) {
  if (!overview) return [];
  return overview.computers
    .filter((c) => c.state === 'running' || (c.id === active && c.state !== 'destroyed'))
    .map((c) => {
      const handoff = (overview.handoffs ?? []).find((h) => h.computerId === c.id);
      const last = overview.activity?.[c.id];
      const calling = answering && overview.running?.[c.id];
      const platform = c.platform;
      return {
        id: c.id,
        label: c.chatLabel ?? c.name ?? c.id,
        ...(platform ? { platform } : {}),
        state: c.state,
        ...(handoff ? { handoffId: handoff.handoffId } : {}),
        held: handoff?.runId === 'person',
        ...(handoff && handoff.runId !== 'person' ? { waiting: handoff.reason } : {}),
        ...(last ? { last: { tool: last.tool, ...(last.summary ? { summary: last.summary } : {}), at: last.at } } : {}),
        ...(calling ? { calling: calling.tool } : {}),
        live: PUSHED_SCREEN.has(c.provider),
        ...(platform && icons[platform] ? { icon: icons[platform] } : {}),
      };
    });
}

/**
 * With "open by itself" on (asked once, at first run): a running computer a
 * chat used since `since`, not shown yet this run, from when its call starts
 * rather than when it ends. One the person closed stays closed.
 */
export function toOpen(overview, since, seen) {
  if (!overview) return [];
  const used = (id) => Math.max(Date.parse(overview.running?.[id]?.since ?? '') || 0, Date.parse(overview.activity?.[id]?.at ?? '') || 0);
  return overview.computers.filter((c) => c.state === 'running' && !seen.has(c.id) && used(c.id) > since).map((c) => c.id);
}

/** Where a chat app's own icon can be read on this machine, where it is installed in the usual place. */
export function appIconPaths(platform, os, env = {}) {
  const local = env.LOCALAPPDATA ?? '';
  const places = {
    darwin: {
      'Claude Desktop': ['/Applications/Claude.app'],
      Cursor: ['/Applications/Cursor.app'],
      'VS Code': ['/Applications/Visual Studio Code.app'],
      Windsurf: ['/Applications/Windsurf.app'],
    },
    win32: {
      'Claude Desktop': [win32.join(local, 'AnthropicClaude', 'claude.exe')],
      Cursor: [win32.join(local, 'Programs', 'cursor', 'Cursor.exe')],
      'VS Code': [win32.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe')],
      Windsurf: [win32.join(local, 'Programs', 'Windsurf', 'Windsurf.exe')],
    },
  };
  return places[os]?.[platform] ?? [];
}
