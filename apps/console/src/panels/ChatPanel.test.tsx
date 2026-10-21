import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HuskApi } from '../api/client';
import type { Overview } from '../api/wire';
import { ChatPanel } from './ChatPanel';

const api = new HuskApi({ baseUrl: 'http://localhost:7377', token: 'test-token' });
vi.mock('../state/connection', () => ({ useConnection: () => ({ api, revision: 0, invalidate: () => {} }) }));

const overview: Overview = {
  computers: [
    {
      id: 'cmp_chat', name: 'mcp-x', state: 'running', createdAt: '', lastUsedAt: '', image: 'x', workdir: '/work', spec: {}, provider: 'docker',
      chatLabel: 'Claude Code · chat started 10:42', platform: 'Claude Code',
    } as Overview['computers'][number],
  ],
  activeRuns: [],
  handoffs: [],
};

/** A websocket that records where it went and lets a test speak for the server. */
class FakeSocket {
  static last: FakeSocket | undefined;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  close() {
    this.closed = true;
  }
  say(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

let calls: Array<{ method: string; path: string; body?: string }>;
let existing = false;
beforeEach(() => {
  calls = [];
  existing = false;
  // A socket from the last test must never stand in for this one's.
  FakeSocket.last = undefined;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      calls.push({ method: init?.method ?? 'GET', path, ...(init?.body ? { body: String(init.body) } : {}) });
      if (path === '/v1/overview') return Response.json(overview);
      if (path === '/v1/computers/cmp_chat/activity')
        return Response.json({ entries: [{ at: '2026-10-21T10:43:00Z', tool: 'shell', ok: true, ms: 120, via: 'mcp', summary: 'npm test' }] });
      if (path === '/v1/computers/cmp_chat/bot')
        return Response.json({ transcriptId: 'tr_1', yaml: 'name: ci-triage\n', spec: { name: 'ci-triage' }, distilled: { confidence: 0.16, notes: ['Review the persona before shipping.'] } });
      if (path === '/v1/husks/ci-triage' && (init?.method ?? 'GET') === 'GET')
        return existing ? Response.json({ spec: { name: 'ci-triage' }, yaml: '' }) : Response.json({ error: { code: 'E_HUSK_NOT_FOUND', message: 'no' } }, { status: 404 });
      if (path === '/v1/husks' && init?.method === 'POST') return Response.json({ name: 'ci-triage', displayName: 'x', description: '', model: 'auto' }, { status: 201 });
      if (path === '/v1/computers/cmp_chat/takeover')
        return Response.json({ handoffId: 'hnd_me', runId: 'person', husk: 'you', reason: 'x', computerId: 'cmp_chat', createdAt: '' }, { status: 201 });
      if (path === '/v1/handoffs/hnd_me/input') return new Response(null, { status: 204 });
      if (path === '/v1/handoffs/hnd_me/done') return Response.json({ handoffId: 'hnd_me', outcome: 'done' });
      return Response.json({ error: { code: 'E_ROUTE_NOT_FOUND', message: 'no' } }, { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Chat panel', () => {
  it('shows what the chat did, newest first, with its summary', async () => {
    render(<ChatPanel computerId="cmp_chat" onOpen={() => {}} />);
    expect(await screen.findByText('npm test', { exact: false })).toBeTruthy();
    expect(screen.getByText('shell')).toBeTruthy();
  });

  it('opens the live screen with the token, and says when no browser is open', async () => {
    render(<ChatPanel computerId="cmp_chat" onOpen={() => {}} />);
    await screen.findByText('Claude Code · chat started 10:42');
    await waitFor(() => expect(FakeSocket.last).toBeDefined());
    const ws = FakeSocket.last!;
    expect(ws.url).toBe('ws://localhost:7377/v1/computers/cmp_chat/screen?token=test-token');
    act(() => ws.say({ type: 'idle', message: 'x' }));
    expect(screen.getByText(/No browser open yet/)).toBeTruthy();
    act(() => ws.say({ type: 'frame', data: 'AAAA', width: 800, height: 600 }));
    expect((screen.getByAltText('The browser on cmp_chat, live') as HTMLImageElement).src).toContain('data:image/jpeg;base64,AAAA');
  });

  /** The page at 1280x800, drawn at half size. */
  async function frameShown() {
    await screen.findByText('Claude Code · chat started 10:42');
    await waitFor(() => expect(FakeSocket.last).toBeDefined());
    act(() => FakeSocket.last!.say({ type: 'frame', data: 'AAAA', width: 1280, height: 800 }));
    const img = screen.getByAltText('The browser on cmp_chat, live');
    img.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 400, right: 650, bottom: 420, x: 10, y: 20, toJSON: () => ({}) });
    return img;
  }
  const inputs = () => calls.filter((c) => c.path === '/v1/handoffs/hnd_me/input').map((c) => JSON.parse(c.body!));

  it('offers Take over when the screen is clicked, and takes the computer', async () => {
    render(<ChatPanel computerId="cmp_chat" onOpen={() => {}} />);
    await frameShown();
    expect(screen.queryByLabelText('Type into the page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take over this computer' }));
    const offer = screen.getByRole('group', { name: 'Take over' });
    fireEvent.click(within(offer).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/computers/cmp_chat/takeover')).toBe(true));
  });

  it('sends clicks, typing and keys straight to the page while held, in order, and gives back', async () => {
    overview.handoffs = [{ handoffId: 'hnd_me', runId: 'person', husk: 'you', reason: 'You took over this computer', computerId: 'cmp_chat', createdAt: '' }];
    try {
      render(<ChatPanel computerId="cmp_chat" onOpen={() => {}} />);
      const img = await frameShown();
      expect(screen.getByText('You’re in control')).toBeTruthy();

      fireEvent.click(img, { clientX: 330, clientY: 120 });
      const keys = screen.getByLabelText('Type into the page') as HTMLInputElement;
      expect(keys.type).toBe('password');
      expect(document.activeElement).toBe(keys);
      fireEvent.change(keys, { target: { value: 'hunter2' } });
      expect(keys.value).toBe('');
      fireEvent.keyDown(keys, { key: 'Enter' });
      fireEvent.keyDown(keys, { key: 'Tab' }); // left to the browser, so the keyboard can leave
      await waitFor(() => expect(inputs()).toHaveLength(3));
      expect(inputs()).toEqual([
        { type: 'click', x: 640, y: 200 },
        { type: 'text', text: 'hunter2' },
        { type: 'key', key: 'Enter' },
      ]);
      expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain('hunter2');

      fireEvent.click(screen.getByRole('button', { name: 'Give back' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/handoffs/hnd_me/done')).toBe(true));
    } finally {
      overview.handoffs = [];
    }
  });

  it('closes the screen when the panel goes away', async () => {
    const { unmount } = render(<ChatPanel computerId="cmp_chat" onOpen={() => {}} />);
    await screen.findByText('Claude Code · chat started 10:42');
    await waitFor(() => expect(FakeSocket.last).toBeDefined());
    const ws = FakeSocket.last!;
    unmount();
    expect(ws.closed).toBe(true);
  });

  it('shows the bot draft before saving it, then creates it', async () => {
    render(<ChatPanel computerId="cmp_chat" onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make this a bot' }));
    expect(await screen.findByText(/confidence 16%/)).toBeTruthy();
    expect(screen.getByText('Review the persona before shipping.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/husks')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save as a bot' }));
    expect(await screen.findByText('Saved as ci-triage. Run it from Husks.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/v1/husks')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('asks before replacing a bot that already has the name', async () => {
    existing = true;
    render(<ChatPanel computerId="cmp_chat" onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make this a bot' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save as a bot' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/husks')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Replace ci-triage' }));
    expect(await screen.findByText('Saved as ci-triage. Run it from Husks.')).toBeTruthy();
  });
});
