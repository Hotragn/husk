import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HuskApi } from '../api/client';
import { desktopView } from '../state/viewerToken';
import { AppGlyph } from './AppGlyph';
import { ago, doing, statusOf, tabName } from './bridge';
import type { DesktopComputer, DesktopState } from './bridge';
import { ComputersWindow } from './ComputersWindow';
import { Dock } from './Dock';
import { logoOf } from './logos';
import { Pill } from './Pill';
import { TINTS, tintOf } from './tints';

const api = new HuskApi({ baseUrl: 'http://localhost:7377', token: 'test-token' });
vi.mock('../state/connection', () => ({ useConnection: () => ({ api, revision: 0, invalidate: () => {} }) }));

const NOW = Date.parse('2026-10-22T10:00:00Z');
const computer = (id: string, extra: Partial<DesktopComputer> = {}): DesktopComputer => ({
  id,
  label: `Claude Code · chat started 09:${id.slice(-2)}`,
  platform: 'Claude Code',
  state: 'running',
  held: false,
  live: true,
  last: { tool: 'browser_goto', summary: 'https://example.com', at: new Date(NOW - 3_000).toISOString() },
  ...extra,
});
const desk = (computers: DesktopComputer[], extra: Partial<DesktopState> = {}): DesktopState => ({ computers, window: 'open', pinned: true, ...extra });

let acts: unknown[];
let requests: string[];
let sockets: string[];
let push: (s: DesktopState) => void;

function bridge(state: DesktopState, platform = 'darwin') {
  const listeners = new Set<(s: DesktopState) => void>();
  push = (s) => listeners.forEach((l) => l(s));
  (window as unknown as { huskDesktop: unknown }).huskDesktop = {
    platform,
    act: async (msg: unknown) => {
      acts.push(msg);
    },
    onState(cb: (s: DesktopState) => void) {
      listeners.add(cb);
      cb(state);
      return () => listeners.delete(cb);
    },
  };
}

beforeEach(() => {
  acts = [];
  requests = [];
  sockets = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      onmessage = null;
      onclose = null;
      constructor(url: string) {
        const u = new URL(url);
        sockets.push(u.pathname + u.search.replace(/[?&]token=[^&]*/, ''));
      }
      close() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/takeover')) return Response.json({ handoffId: 'hnd_me', runId: 'person', husk: 'you', reason: 'x', createdAt: '' }, { status: 201 });
      if (path.endsWith('/done')) return Response.json({ handoffId: 'hnd_me', outcome: 'done' });
      return Response.json({ error: { code: 'E_ROUTE_NOT_FOUND', message: 'no' } }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { huskDesktop?: unknown }).huskDesktop;
});

describe('the Computers window', () => {
  it('has a tab per computer, shows the one in front live, and takes it at a click', async () => {
    bridge(desk([computer('cmp_a01'), computer('cmp_a02', { platform: 'Cursor', label: 'Cursor · chat started 09:02' })], { active: 'cmp_a01' }));
    render(<ComputersWindow />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Claude Code', 'Cursor']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Claude Code · chat started 09:01' })).toBeTruthy();
    expect(sockets).toEqual(['/v1/computers/cmp_a01/screen']);
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(requests).toContain('POST /v1/computers/cmp_a01/takeover'));
    await waitFor(() => expect(acts).toContainEqual({ type: 'refresh' }));
  });

  it('switches computers through the desktop app, which says which tab is in front', async () => {
    bridge(desk([computer('cmp_a01'), computer('cmp_a02', { platform: 'Cursor' })], { active: 'cmp_a01' }));
    render(<ComputersWindow />);
    fireEvent.click(screen.getByRole('tab', { name: /Cursor/ }));
    expect(acts).toEqual([{ type: 'select', id: 'cmp_a02' }]);
    push(desk([computer('cmp_a01'), computer('cmp_a02', { platform: 'Cursor' })], { active: 'cmp_a02' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Cursor/ }).getAttribute('aria-selected')).toBe('true'));
    expect(sockets).toEqual(['/v1/computers/cmp_a01/screen', '/v1/computers/cmp_a02/screen']);
  });

  it('gives a held computer back, with the page keys at hand', async () => {
    bridge(desk([computer('cmp_a01', { held: true, handoffId: 'hnd_me' })]));
    render(<ComputersWindow />);
    expect(screen.getByRole('group', { name: 'Keys' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Give back' }));
    await waitFor(() => expect(requests).toContain('POST /v1/handoffs/hnd_me/done'));
  });

  it('asks before handing a waiting chat its computer back', async () => {
    bridge(desk([computer('cmp_a01', { handoffId: 'hnd_chat', waiting: 'Sign in to GitHub' })]));
    render(<ComputersWindow />);
    expect(screen.getByText('Sign in to GitHub')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(requests).not.toContain('POST /v1/handoffs/hnd_chat/done');
    fireEvent.click(screen.getByRole('button', { name: 'Hand back to the chat' }));
    await waitFor(() => expect(requests).toContain('POST /v1/handoffs/hnd_chat/done'));
  });

  it('draws traffic lights on a Mac, and minimizes to the notch', () => {
    bridge(desk([computer('cmp_a01')]), 'darwin');
    render(<ComputersWindow />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize to the notch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep on top' }));
    expect(acts).toEqual([
      { type: 'window', op: 'minimize' },
      { type: 'window', op: 'pin' },
    ]);
    expect(document.querySelector('.cw-lights')).not.toBeNull();
  });

  it('puts the window controls on the right elsewhere', () => {
    bridge(desk([computer('cmp_a01')]), 'win32');
    render(<ComputersWindow />);
    expect(document.querySelector('.cw-lights')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
    expect(acts).toEqual([{ type: 'window', op: 'close' }]);
  });

  it('opens no screen for a stopped computer, and says when no chat has one', () => {
    bridge(desk([computer('cmp_a01', { state: 'stopped' })]));
    const { unmount } = render(<ComputersWindow />);
    expect(screen.getByText('This computer is stopped. It starts again when its chat uses it.')).toBeTruthy();
    expect(sockets).toEqual([]);
    unmount();
    bridge(desk([]));
    render(<ComputersWindow />);
    expect(screen.getByText('No chat is using a computer right now.')).toBeTruthy();
  });

  it('names two computers of one app apart by when their chats started', () => {
    const all = [computer('cmp_a01'), computer('cmp_a07'), computer('cmp_b01', { platform: 'Zed', label: 'Zed · chat started 08:00' })];
    expect(all.map((c) => tabName(c, all))).toEqual(['Claude Code 09:01', 'Claude Code 09:07', 'Zed']);
    expect(tabName(computer('cmp_x', { platform: undefined, label: 'box' }), all)).toBe('box');
  });
});

describe('the corner row', () => {
  it('stands a small white-screened computer per chat, names it on hover, and opens it on a click', async () => {
    bridge(desk([computer('cmp_a01'), computer('cmp_a02', { platform: 'Claude Desktop', label: 'Claude Desktop · chat started 09:02' })]));
    const { container } = render(<Dock />);
    // jsdom has no WebGL, so this is the flat fallback: the same small iMac.
    await waitFor(() => expect(container.querySelector('.dock-flat')).not.toBeNull());
    expect(container.querySelectorAll('.flat-mac')).toHaveLength(2);
    expect(container.querySelector('.flat-mac-screen img')).toBeNull();
    const first = screen.getByRole('button', { name: /^Claude Code · chat started 09:01: browser_goto https:\/\/example\.com\. Open it$/ });
    fireEvent.pointerEnter(first);
    expect(screen.getByRole('tooltip').textContent).toBe('Claude Code');
    fireEvent.click(first);
    fireEvent.pointerLeave(first);
    expect(acts).toEqual([{ type: 'interactive', on: true }, { type: 'toggle', id: 'cmp_a01' }, { type: 'interactive', on: false }]);
  });

  it('streams nothing: the corner never shows a moving picture', async () => {
    bridge(desk([computer('cmp_a01'), computer('cmp_a02')]));
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelector('.dock-flat')).not.toBeNull());
    expect(sockets).toEqual([]);
  });

  it('draws each flat computer in its chat app’s colour', async () => {
    bridge(desk([computer('cmp_a01'), computer('cmp_a02', { platform: 'VS Code' })]));
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelector('.dock-flat')).not.toBeNull());
    const macs = [...container.querySelectorAll<HTMLElement>('.flat-mac')];
    expect(macs.map((m) => m.style.getPropertyValue('--mac-back'))).toEqual([TINTS.orange.back, TINTS.blue.back]);
  });
});

describe('the notch', () => {
  it('holds a logo per computer in the window, and brings the window back on that tab', () => {
    bridge(desk([computer('cmp_a01'), computer('cmp_a02', { platform: 'Zed' })], { window: 'minimized' }));
    render(<Pill />);
    const logos = screen.getAllByRole('button', { name: /^Open .*chat started/ });
    expect(logos).toHaveLength(2);
    fireEvent.click(logos[1]!);
    expect(acts).toEqual([{ type: 'open', id: 'cmp_a02' }]);
  });

  it('puts the logos either side of a Mac notch', () => {
    bridge(desk([computer('cmp_a01'), computer('cmp_a02'), computer('cmp_a03')], { window: 'minimized', notch: { gap: 200, height: 38 } }));
    const { container } = render(<Pill />);
    const sides = container.querySelectorAll('.pill-side');
    expect([...sides].map((s) => s.querySelectorAll('.pill-logo').length)).toEqual([2, 1]);
    expect((container.querySelector('.pill') as HTMLElement).style.getPropertyValue('--notch-gap')).toBe('200px');
  });

  it('opens into a short list on hover, from which the window opens or is put away', () => {
    bridge(desk([computer('cmp_a02', { waiting: 'Approve the payment' })], { window: 'minimized' }));
    const { container } = render(<Pill />);
    fireEvent.pointerEnter(container.querySelector('.pill')!);
    const list = screen.getByRole('list', { name: 'Computers' });
    expect(within(list).getByTitle('Waiting for you · Approve the payment')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Open Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Put the window away' }));
    expect(acts).toEqual([{ type: 'interactive', on: true }, { type: 'open', id: 'cmp_a02' }, { type: 'dismiss' }]);
  });

  it('follows the desktop app as computers come and go', async () => {
    bridge(desk([], { window: 'minimized' }));
    render(<Pill />);
    expect(screen.queryAllByRole('button', { name: /^Open / })).toHaveLength(0);
    push(desk([computer('cmp_a09')], { window: 'minimized' }));
    expect(await screen.findByRole('button', { name: 'Open Claude Code · chat started 09:09' })).toBeTruthy();
  });
});

describe('the chat apps’ marks', () => {
  it('draws a real mark where Husk has one, the installed icon first, and a monogram otherwise', () => {
    expect(logoOf('Claude Code')?.title).toBe('Claude');
    expect(logoOf('Claude Desktop')?.title).toBe('Claude');
    expect(['Cursor', 'Gemini CLI', 'Zed', 'Windsurf'].map((p) => logoOf(p)?.title)).toEqual(['Cursor', 'Gemini', 'Zed', 'Windsurf']);
    expect(logoOf('Codex CLI')).toBeUndefined();
    const { container: claude } = render(<AppGlyph computer={{ platform: 'Claude Code' }} />);
    expect(claude.querySelector('.glyph-logo svg path')?.getAttribute('d')).toBe(logoOf('Claude')!.path);
    const { container: codex } = render(<AppGlyph computer={{ platform: 'Codex CLI' }} />);
    expect(codex.querySelector('.glyph-mono')?.textContent).toBe('Cx');
    const { container: icon } = render(<AppGlyph computer={{ platform: 'VS Code', icon: 'data:image/png;base64,x' }} />);
    expect(icon.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,x');
  });

  it('draws a mark on the white screen of a nearly invisible computer, the husk, where asked', () => {
    const { container } = render(<AppGlyph computer={{ platform: 'Cursor' }} size={20} husk />);
    const husk = container.querySelector('svg.glyph-husk')!;
    const [shell, screen] = [...husk.querySelectorAll(':scope > path')];
    expect(shell!.getAttribute('fill')).toBe('none');
    expect(Number(shell!.getAttribute('stroke-opacity'))).toBeLessThan(0.5);
    expect(screen!.getAttribute('fill')).toBe('#fff');
    expect(husk.querySelector(':scope svg path')?.getAttribute('d')).toBe(logoOf('Cursor')!.path);
    const { container: codex } = render(<AppGlyph computer={{ platform: 'Codex CLI' }} husk />);
    expect(codex.querySelector('svg.glyph-husk text')?.textContent).toBe('Cx');
  });

  it('keeps one colour per chat app, and a steady one for any other', () => {
    expect(tintOf('Claude Code', 'cmp_a')).toBe('orange');
    expect(tintOf('VS Code', 'cmp_c')).toBe('blue');
    expect(tintOf('Gemini CLI', 'cmp_d')).toBe('purple');
    expect(tintOf(undefined, 'cmp_x1')).toBe(tintOf(undefined, 'cmp_x1'));
    expect(Object.keys(TINTS)).toContain(tintOf('Some new app', 'cmp_x2'));
  });
});

describe('the words for a computer', () => {
  it('says who has it and what it is doing', () => {
    expect(statusOf(computer('cmp_a01'), NOW)).toBe('active');
    expect(statusOf(computer('cmp_a01', { last: { tool: 'shell', at: new Date(NOW - 60_000).toISOString() } }), NOW)).toBe('idle');
    expect(statusOf(computer('cmp_a01', { held: true }), NOW)).toBe('held');
    expect(statusOf(computer('cmp_a01', { waiting: 'x' }), NOW)).toBe('waiting');
    expect(statusOf(computer('cmp_a01', { state: 'stopped', held: true }), NOW)).toBe('stopped');
    expect(doing(computer('cmp_a01'))).toBe('browser_goto https://example.com');
    expect(doing(computer('cmp_a01', { held: true }))).toBe('You have it');
    expect(ago(new Date(NOW - 2_000).toISOString(), NOW)).toBe('now');
    expect(ago(new Date(NOW - 42_000).toISOString(), NOW)).toBe('42s ago');
    expect(ago(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago');
  });

  it('reads which desktop window a page is from its address, and nothing else', () => {
    const at = (hash: string) => {
      window.history.replaceState(null, '', `/${hash}`);
      return desktopView();
    };
    expect(at('#view=computers')).toEqual({ view: 'computers' });
    expect(at('#token=t&view=dock')).toEqual({ view: 'dock' });
    expect(at('#view=pill')).toEqual({ view: 'pill' });
    expect(at('#view=computer&id=cmp_a01')).toBeNull();
    expect(at('#view=shell')).toBeNull();
    window.history.replaceState(null, '', '/');
  });
});
