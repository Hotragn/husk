import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HuskApi } from '../api/client';
import { desktopView } from '../state/viewerToken';
import { ago, doing, statusOf } from './bridge';
import type { DesktopComputer, DesktopState } from './bridge';
import { ComputerWindow } from './ComputerWindow';
import { Dock, docked } from './Dock';
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
  window: 'open',
  pinned: true,
  held: false,
  live: true,
  last: { tool: 'browser_goto', summary: 'https://example.com', at: new Date(NOW - 3_000).toISOString() },
  ...extra,
});

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
      if (path.endsWith('/browser/tabs'))
        return Response.json({
          tabs: [
            { targetId: 't1', url: 'https://example.com/', title: 'Example Domain', active: true },
            { targetId: 't2', url: 'https://github.com/login', title: '', active: false },
            { targetId: 't3', url: 'about:blank', title: 'about:blank', active: false },
          ],
        });
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

describe('a computer window', () => {
  it('shows the chat, its tabs by name, and its screen live, and takes the computer at a click', async () => {
    bridge({ computers: [computer('cmp_a01')] });
    render(<ComputerWindow id="cmp_a01" />);
    expect(screen.getAllByText('Claude Code · chat started 09:01').length).toBeGreaterThan(0);
    const tabs = await screen.findByRole('navigation', { name: 'Tabs on this computer' });
    expect(within(tabs).getByText('Example Domain').getAttribute('aria-current')).toBe('page');
    // A tab with no title yet goes by its host.
    expect(within(tabs).getByText('github.com')).toBeTruthy();
    // A blank one is a new tab, as a browser says.
    expect(within(tabs).getByText('New tab')).toBeTruthy();
    expect(sockets).toEqual(['/v1/computers/cmp_a01/screen']);
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(requests).toContain('POST /v1/computers/cmp_a01/takeover'));
    await waitFor(() => expect(acts).toContainEqual({ type: 'refresh' }));
  });

  it('gives a held computer back, with the page keys at hand', async () => {
    bridge({ computers: [computer('cmp_a01', { held: true, handoffId: 'hnd_me' })] });
    render(<ComputerWindow id="cmp_a01" />);
    expect(screen.getByRole('group', { name: 'Keys' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Give back' }));
    await waitFor(() => expect(requests).toContain('POST /v1/handoffs/hnd_me/done'));
  });

  it('asks before handing a waiting chat its computer back', async () => {
    bridge({ computers: [computer('cmp_a01', { handoffId: 'hnd_chat', waiting: 'Sign in to GitHub' })] });
    render(<ComputerWindow id="cmp_a01" />);
    expect(screen.getByText('Sign in to GitHub')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(requests).not.toContain('POST /v1/handoffs/hnd_chat/done');
    fireEvent.click(screen.getByRole('button', { name: 'Hand back to the chat' }));
    await waitFor(() => expect(requests).toContain('POST /v1/handoffs/hnd_chat/done'));
  });

  it('draws traffic lights on a Mac, and minimizes to the notch', () => {
    bridge({ computers: [computer('cmp_a01')] }, 'darwin');
    render(<ComputerWindow id="cmp_a01" />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize to the notch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep on top' }));
    expect(acts).toEqual([
      { type: 'window', op: 'minimize' },
      { type: 'window', op: 'pin' },
    ]);
    expect(document.querySelector('.cw-lights')).not.toBeNull();
  });

  it('puts the window controls on the right elsewhere', () => {
    bridge({ computers: [computer('cmp_a01')] }, 'win32');
    render(<ComputerWindow id="cmp_a01" />);
    expect(document.querySelector('.cw-lights')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
    expect(acts).toEqual([{ type: 'window', op: 'close' }]);
  });

  it('opens no screen for a stopped computer', () => {
    bridge({ computers: [computer('cmp_a01', { state: 'stopped' })] });
    render(<ComputerWindow id="cmp_a01" />);
    expect(screen.getByText('This computer is stopped. It starts again when its chat uses it.')).toBeTruthy();
    expect(sockets).toEqual([]);
  });
});

describe('the row of 3D computers', () => {
  it('stands running computers and open windows, not closed stopped ones', () => {
    const list = [computer('cmp_a01'), computer('cmp_a02', { state: 'stopped', window: 'closed' }), computer('cmp_a03', { state: 'stopped', window: 'minimized' })];
    expect(docked(list).map((c) => c.id)).toEqual(['cmp_a01', 'cmp_a03']);
  });

  it('falls back to flat computers without WebGL, names each on hover, and toggles its window', async () => {
    bridge({ computers: [computer('cmp_a01'), computer('cmp_a02', { platform: 'Claude Desktop', label: 'Claude Desktop · chat started 09:02', window: 'minimized' })] });
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelector('.dock-flat')).not.toBeNull());
    const first = screen.getByRole('button', { name: /^Claude Code · chat started 09:01: browser_goto https:\/\/example\.com\. Hide its window$/ });
    fireEvent.pointerEnter(first);
    expect(screen.getByRole('tooltip').textContent).toContain('Claude Code · chat started 09:01');
    fireEvent.click(first);
    fireEvent.pointerLeave(first);
    expect(acts).toEqual([{ type: 'interactive', on: true }, { type: 'toggle', id: 'cmp_a01' }, { type: 'interactive', on: false }]);
    expect(screen.getByRole('button', { name: /Claude Desktop .* Show its window$/ })).toBeTruthy();
    // Each screen is live, slowly: a frame a second.
    expect(sockets.sort()).toEqual(['/v1/computers/cmp_a01/screen?fps=1', '/v1/computers/cmp_a02/screen?fps=1']);
  });

  it('draws each flat computer as a front-facing iMac in its chat app’s colour', async () => {
    bridge({ computers: [computer('cmp_a01'), computer('cmp_a02', { platform: 'VS Code' })] });
    const { container } = render(<Dock />);
    await waitFor(() => expect(container.querySelector('.dock-flat')).not.toBeNull());
    const macs = [...container.querySelectorAll<HTMLElement>('.flat-mac')];
    expect(macs.map((m) => m.style.getPropertyValue('--mac-back'))).toEqual([TINTS.orange.back, TINTS.blue.back]);
    expect(macs[0]!.querySelector('.flat-mac-chin')).not.toBeNull();
  });

  it('opens no screen where watching would count as use', () => {
    bridge({ computers: [computer('cmp_a01', { live: false })] });
    render(<Dock />);
    expect(sockets).toEqual([]);
  });
});

describe('the notch', () => {
  it('holds only minimized computers, and opens one at a click', () => {
    bridge({ computers: [computer('cmp_a01'), computer('cmp_a02', { window: 'minimized' })] });
    render(<Pill />);
    const logos = screen.getAllByRole('button', { name: /^Open / });
    expect(logos).toHaveLength(1);
    fireEvent.click(logos[0]!);
    expect(acts).toEqual([{ type: 'open', id: 'cmp_a02' }]);
  });

  it('puts the logos either side of a Mac notch', () => {
    bridge({
      computers: [computer('cmp_a01', { window: 'minimized' }), computer('cmp_a02', { window: 'minimized' }), computer('cmp_a03', { window: 'minimized' })],
      notch: { gap: 200, height: 38 },
    });
    const { container } = render(<Pill />);
    const sides = container.querySelectorAll('.pill-side');
    expect([...sides].map((s) => s.querySelectorAll('.pill-logo').length)).toEqual([2, 1]);
    expect((container.querySelector('.pill') as HTMLElement).style.getPropertyValue('--notch-gap')).toBe('200px');
  });

  it('opens into a list on hover, where a window can be opened or closed', () => {
    bridge({ computers: [computer('cmp_a02', { window: 'minimized', waiting: 'Approve the payment' })] });
    const { container } = render(<Pill />);
    fireEvent.pointerEnter(container.querySelector('.pill')!);
    const list = screen.getByRole('list', { name: 'Minimized computers' });
    expect(within(list).getByTitle('Waiting for you · Approve the payment')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Close Claude Code · chat started 09:02’s window' }));
    fireEvent.click(within(list).getByRole('button', { name: 'Open' }));
    expect(acts).toEqual([
      { type: 'interactive', on: true },
      { type: 'close', id: 'cmp_a02' },
      { type: 'open', id: 'cmp_a02' },
    ]);
  });

  it('follows the desktop app as windows come and go', async () => {
    bridge({ computers: [] });
    render(<Pill />);
    expect(screen.queryAllByRole('button', { name: /^Open / })).toHaveLength(0);
    push({ computers: [computer('cmp_a09', { window: 'minimized' })] });
    expect(await screen.findByRole('button', { name: 'Open Claude Code · chat started 09:09' })).toBeTruthy();
  });
});

describe('the colours of the computers', () => {
  it('keeps one colour per chat app, and a steady one for any other', () => {
    expect(tintOf('Claude Code', 'cmp_a')).toBe('orange');
    expect(tintOf('Claude Desktop', 'cmp_b')).toBe('orange');
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
    expect(at('#view=computer&id=cmp_a01')).toEqual({ view: 'computer', id: 'cmp_a01' });
    expect(at('#token=t&view=dock')).toEqual({ view: 'dock' });
    expect(at('#view=pill')).toEqual({ view: 'pill' });
    expect(at('#view=computer&id=../../x')).toBeNull();
    expect(at('#view=shell')).toBeNull();
    window.history.replaceState(null, '', '/');
  });
});
