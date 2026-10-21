import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
beforeEach(() => {
  calls = [];
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
      if (path === '/v1/husks/ci-triage') return Response.json({ name: 'ci-triage', displayName: 'x', description: '', model: 'auto' });
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
    expect(screen.getByText(/No browser is open on this computer yet/)).toBeTruthy();
    act(() => ws.say({ type: 'frame', data: 'AAAA', width: 800, height: 600 }));
    expect((screen.getByAltText('The browser on cmp_chat, live') as HTMLImageElement).src).toContain('data:image/jpeg;base64,AAAA');
  });

  it('closes the screen when the panel goes away', async () => {
    const { unmount } = render(<ChatPanel computerId="cmp_chat" onOpen={() => {}} />);
    await screen.findByText('Claude Code · chat started 10:42');
    await waitFor(() => expect(FakeSocket.last).toBeDefined());
    const ws = FakeSocket.last!;
    unmount();
    expect(ws.closed).toBe(true);
  });

  it('shows the bot draft before saving it, then saves it', async () => {
    render(<ChatPanel computerId="cmp_chat" onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make this a bot' }));
    expect(await screen.findByText(/confidence 16%/)).toBeTruthy();
    expect(screen.getByText('Review the persona before shipping.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save as a bot' }));
    expect(await screen.findByText('Saved as ci-triage. Run it from Husks.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/v1/husks/ci-triage');
  });
});
