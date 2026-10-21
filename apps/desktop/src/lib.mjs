// The desktop app's decisions, kept apart from Electron so `node --test` can
// check them without starting a window.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
 * Node, on the bundled bin.js. Nothing for the person to install.
 */
export function launchFor(execPath, bin) {
  return { command: execPath, args: [bin], env: { ELECTRON_RUN_AS_NODE: '1' } };
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

/** The tray's one line, from GET /v1/overview. */
export function trayStatus(overview) {
  if (!overview) return { label: 'Husk is starting', waiting: [] };
  const running = overview.computers.filter((c) => c.state === 'running').length;
  const waiting = overview.handoffs ?? [];
  const parts = [`${running} computer${running === 1 ? '' : 's'} running`];
  if (waiting.length) parts.push(`${waiting.length} waiting for you`);
  return { label: parts.join(' · '), waiting };
}

/** Handoffs that were not waiting last time: one notification each. */
export function newlyWaiting(before, after) {
  const seen = new Set(before.map((h) => h.handoffId));
  return after.filter((h) => !seen.has(h.handoffId));
}
