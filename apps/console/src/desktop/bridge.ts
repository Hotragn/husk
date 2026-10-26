/**
 * What the Husk desktop app (`apps/desktop`) tells its small windows, and the
 * few things they may ask of it. Its preload puts `window.huskDesktop` there;
 * in a plain browser it is absent, and these views say so.
 *
 * The desktop app is the one source of what is on screen: which computers
 * are running, which one the Computers window shows, whether that window is
 * open or minimized, who holds each computer. It reads that from the shared
 * Husk every couple of seconds and sends it to every window, so the window,
 * the corner row and the notch never disagree.
 */

import { useEffect, useRef, useState } from 'react';

export interface DesktopComputer {
  id: string;
  /** "Claude Code · chat started 09:00", or the computer's name. */
  label: string;
  /** The chat app: "Claude Code", "Claude Desktop", "Cursor"... */
  platform?: string;
  state: string;
  /** The open handoff on it, if any: the person's own hold, or a chat waiting for them. */
  handoffId?: string;
  /** The person took it. */
  held: boolean;
  /** A chat asked the person for something, and why. */
  waiting?: string;
  last?: { tool: string; summary?: string; at: string };
  /** The tool the AI is running on it now: a long call is still work, and a take-over waits for it. */
  calling?: string;
  /** Its screen is pushed, so watching it never counts as using the computer. */
  live: boolean;
  /** The chat app's own icon as a data URL, where the desktop app found one. */
  icon?: string;
}

export interface DesktopState {
  /** The running computers: the corner row, and the Computers window's tabs. */
  computers: DesktopComputer[];
  /** The tab the Computers window shows. */
  active?: string;
  window: 'open' | 'minimized' | 'closed';
  /** The window stays on top of other windows. */
  pinned: boolean;
  /**
   * False while the shared Husk is not answering: a banner says so, the screens
   * are cleared rather than left frozen on their last frame, and nothing that
   * needs Husk is offered. Absent from an older app: then it is answering.
   */
  connected?: boolean;
  /** A Mac with a notch: the pill wraps it, its logos left and right of `gap` pixels. */
  notch?: { gap: number; height: number };
}

/**
 * What a page may ask. The desktop app takes each only from the page it is
 * for: `toggle` from the corner row, `open` and `dismiss` from the notch,
 * `select` and `window` from the Computers window.
 */
export type DesktopAct =
  | { type: 'toggle'; id: string }
  | { type: 'open'; id: string }
  | { type: 'dismiss' }
  | { type: 'select'; id: string }
  | { type: 'console'; id: string }
  | { type: 'interactive'; on: boolean }
  /** The corner or the notch gives the keyboard back to whatever had it before the app's shortcut. */
  | { type: 'release' }
  /** Linux: where the corner or the notch draws, in its window's pixels; clicks elsewhere reach the windows under it. */
  | { type: 'shape'; rects: Array<{ x: number; y: number; width: number; height: number }> }
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

/**
 * The keyboard arriving from the app's shortcut, for the corner and the notch,
 * which take it from nothing else: their window gets focus, `then` runs, and
 * the first button in `within` takes it, unless one there has it already.
 * Returns the listener's cleanup, for an effect.
 */
export function arrive(within: { current: HTMLElement | null }, then?: () => void): () => void {
  const on = () => {
    then?.();
    if (!within.current?.contains(document.activeElement)) within.current?.querySelector('button')?.focus();
  };
  window.addEventListener('focus', on);
  return () => window.removeEventListener('focus', on);
}

/**
 * Linux cannot pass clicks through a window's clear parts, so there the
 * corner and the notch tell the app where they draw: the boxes of what
 * `selector` matches, after every render and whenever those boxes change (a
 * list opening, a label fading in), and the app lets clicks through the rest
 * of the window. Elsewhere, and when nothing changed, nothing is sent.
 */
export function useShape(selector: string): void {
  const sent = useRef('');
  useEffect(() => {
    const desk = desktopBridge();
    if (desk?.platform !== 'linux') return;
    const send = () => {
      const rects = [...document.querySelectorAll(selector)]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height }));
      const key = JSON.stringify(rects);
      if (!rects.length || key === sent.current) return;
      sent.current = key;
      void desk.act({ type: 'shape', rects });
    };
    send();
    const observer = new ResizeObserver(send);
    for (const el of document.querySelectorAll(selector)) observer.observe(el);
    // A transform is no resize: what animates in is measured again once it has.
    const events = ['resize', 'animationend', 'transitionend'];
    for (const e of events) window.addEventListener(e, send);
    return () => {
      observer.disconnect();
      for (const e of events) window.removeEventListener(e, send);
    };
  });
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
  if (c.calling) return 'active';
  return c.last && now - Date.parse(c.last.at) < 15_000 ? 'active' : 'idle';
}

/**
 * A computer's name on its tab: its chat app, with the time its chat started
 * where two computers belong to the same app; else its label.
 */
export function tabName(c: DesktopComputer, all: DesktopComputer[]): string {
  if (!c.platform) return c.label;
  const twin = all.some((o) => o.id !== c.id && o.platform === c.platform);
  const time = /\b(\d{1,2}:\d{2})\b/.exec(c.label)?.[1];
  return twin && time ? `${c.platform} ${time}` : c.platform;
}

/** What a computer is doing, in a few words: nothing anyone can tell while Husk is `away`. */
export function doing(c: DesktopComputer, away = false): string {
  if (away) return 'Husk is not answering';
  if (c.held) return 'You have it';
  if (c.waiting) return `Waiting for you · ${c.waiting}`;
  if (c.state !== 'running') return c.state === 'stopped' ? 'Stopped' : c.state;
  if (c.calling) return `${c.calling}…`;
  if (!c.last) return 'Ready';
  return [c.last.tool, c.last.summary].filter(Boolean).join(' ');
}

/** While a take-over waits for the AI's call to stop: never long, but never a silent spinner. */
export function takingText(tool: string): string {
  return `Taking over: waiting for ${tool} to stop…`;
}
