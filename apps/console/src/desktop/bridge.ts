/**
 * What the Husk desktop app (`apps/desktop`) tells its small windows, and the
 * few things they may ask of it. Its preload puts `window.huskDesktop` there;
 * in a plain browser it is absent, and these views say so.
 *
 * The desktop app is the one source of what is on screen: which computers
 * exist, whose window is open or minimized, who holds each one. It reads that
 * from the shared Husk every couple of seconds and sends it to every window,
 * so the computer window, the row of 3D computers and the notch never
 * disagree.
 */

import { useEffect, useState } from 'react';

export interface DesktopComputer {
  id: string;
  /** "Claude Code · chat started 09:00", or the computer's name. */
  label: string;
  /** The chat app: "Claude Code", "Claude Desktop", "Cursor"... */
  platform?: string;
  state: string;
  window: 'open' | 'minimized' | 'closed';
  /** On top of other windows. */
  pinned: boolean;
  /** The open handoff on it, if any: the person's own hold, or a chat waiting for them. */
  handoffId?: string;
  /** The person took it. */
  held: boolean;
  /** A chat asked the person for something, and why. */
  waiting?: string;
  last?: { tool: string; summary?: string; at: string };
  /** Its screen is pushed, so watching it never counts as using the computer. */
  live: boolean;
  /** The chat app's own icon as a data URL, where the desktop app found one. */
  icon?: string;
}

export interface DesktopState {
  computers: DesktopComputer[];
  /** A Mac with a notch: the pill wraps it, its logos left and right of `gap` pixels. */
  notch?: { gap: number; height: number };
}

export type DesktopAct =
  | { type: 'toggle'; id: string }
  | { type: 'open'; id: string }
  | { type: 'close'; id: string }
  | { type: 'console'; id: string }
  | { type: 'interactive'; on: boolean }
  | { type: 'window'; op: 'close' | 'minimize' | 'maximize' | 'pin' }
  | { type: 'refresh' };

export interface DesktopBridge {
  platform: string;
  act(msg: DesktopAct): Promise<unknown>;
  onState(cb: (state: DesktopState) => void): () => void;
}

export function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { huskDesktop?: DesktopBridge }).huskDesktop;
}

/** The desktop app's latest word on every computer, or null before the first one. */
export function useDesktopState(): DesktopState | null {
  const [state, setState] = useState<DesktopState | null>(null);
  useEffect(() => desktopBridge()?.onState(setState), []);
  return state;
}

/** "3s ago", "4 min ago": how long since a chat's last call, for a status line. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export type DeskStatus = 'idle' | 'active' | 'waiting' | 'held' | 'stopped';

/** One word for a computer's light: the dock's glow, the notch's dot, the window's status. */
export function statusOf(c: DesktopComputer, now = Date.now()): DeskStatus {
  if (c.state !== 'running') return 'stopped';
  if (c.held) return 'held';
  if (c.waiting) return 'waiting';
  return c.last && now - Date.parse(c.last.at) < 15_000 ? 'active' : 'idle';
}

/** What a computer is doing, in a few words. */
export function doing(c: DesktopComputer): string {
  if (c.held) return 'You have it';
  if (c.waiting) return `Waiting for you · ${c.waiting}`;
  if (c.state !== 'running') return c.state === 'stopped' ? 'Stopped' : c.state;
  if (!c.last) return 'Ready';
  return [c.last.tool, c.last.summary].filter(Boolean).join(' ');
}
