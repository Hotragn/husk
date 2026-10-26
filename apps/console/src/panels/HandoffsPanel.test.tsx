import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HuskApi } from '../api/client';
import { HandoffsPanel, LinkedComputer, LinkedHandoff } from './HandoffsPanel';

const api = new HuskApi({ baseUrl: 'http://localhost:7377', token: 'test-token' });
vi.mock('../state/connection', () => ({ useConnection: () => ({ api }) }));

const REASON = '<img src=x onerror="alert(1)"> Sign in to example.com';
const handoff = { handoffId: 'hnd_1', runId: 'run_1', husk: 'triage', reason: REASON, computerId: 'cmp_1', createdAt: '2026-10-18T10:00:00Z' };

describe('Handoffs panel', () => {
  let requests: Array<{ path: string; method: string; body?: unknown; auth?: string | null }>;
  let open: boolean;

  beforeEach(() => {
    requests = [];
    open = true;
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:frame', revokeObjectURL: () => {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const path = new URL(input).pathname;
        const auth = new Headers(init.headers).get('authorization');
        requests.push({ path, method: init.method ?? 'GET', auth, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (path === '/v1/handoffs/hnd_1' && (init.method ?? 'GET') === 'GET') {
          return open ? Response.json(handoff) : Response.json({ error: { code: 'E_HANDOFF_NOT_FOUND', message: 'gone' } }, { status: 404 });
        }
        if (path === '/v1/handoffs') return Response.json({ handoffs: open ? [handoff] : [] });
        if (path === '/v1/handoffs/hnd_1/screen') {
          return new Response(new Blob(['jpeg']), { headers: { 'content-type': 'image/jpeg', 'x-husk-viewport': '1280x720' } });
        }
        if (path === '/v1/handoffs/hnd_1/input') return new Response(null, { status: 204 });
        if (path === '/v1/handoffs/hnd_1/done') {
          open = false;
          return Response.json({ handoffId: 'hnd_1', outcome: 'done' });
        }
        return Response.json({ error: { code: 'E_ROUTE_NOT_FOUND', message: 'no' } }, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the reason as text, never as markup', async () => {
    const { container } = render(<HandoffsPanel />);
    expect(await screen.findByText(REASON)).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  it('holds typed text in a password field, sends it once with the token, and clears it', async () => {
    render(<HandoffsPanel />);
    const field = (await screen.findByLabelText('Type into the page')) as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('off');
    fireEvent.change(field, { target: { value: '913' } });
    fireEvent.change(field, { target: { value: '377' } });
    await waitFor(() => expect(requests.some((r) => r.path.endsWith('/input'))).toBe(true));
    expect(requests.filter((r) => r.path.endsWith('/input'))).toHaveLength(1);
    const sent = requests.find((r) => r.path.endsWith('/input'));
    expect(sent?.body).toEqual({ type: 'text', text: '913377' });
    expect(sent?.auth).toBe('Bearer test-token');
    expect(field.value).toBe('');
  });

  it('needs a second, explicit confirmation before handing the run back', async () => {
    render(<HandoffsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    expect(requests.some((r) => r.path.endsWith('/done'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, hand back to the agent' }));
    await waitFor(() => expect(requests.some((r) => r.path.endsWith('/done') && r.method === 'POST')).toBe(true));
    expect(await screen.findByText('Nothing is waiting on you')).toBeTruthy();
  });

  it('opens one handoff from a link, with the reason as text, and never lists the others', async () => {
    const { container } = render(<LinkedHandoff handoffId="hnd_1" />);
    expect(await screen.findByText(REASON)).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(requests.some((r) => r.path === '/v1/handoffs')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, hand back to the agent' }));
    expect(await screen.findByText('Handed back')).toBeTruthy();
  });

  it('says plainly when the linked handoff has ended', async () => {
    open = false;
    render(<LinkedHandoff handoffId="hnd_1" />);
    expect(await screen.findByText('This handoff has ended')).toBeTruthy();
  });
});

describe('a computer opened from its in-chat card', () => {
  let scoped: Response | (() => Response);
  let posts: string[];
  beforeEach(() => {
    posts = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:frame', revokeObjectURL: () => {} }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const path = new URL(input).pathname;
        if (init.method === 'POST') posts.push(path);
        if (path === '/v1/scoped/computer/takeover') {
          return Response.json({ handoffId: 'hnd_me', runId: 'person', husk: 'you', reason: 'You took over this computer', computerId: 'cmp_1', createdAt: '' }, { status: 201 });
        }
        if (path === '/v1/handoffs/hnd_me/screen') {
          return new Response(new Blob(['jpeg']), { headers: { 'content-type': 'image/jpeg', 'x-husk-viewport': '1280x720' } });
        }
        if (path === '/v1/handoffs/hnd_me/done') return Response.json({ handoffId: 'hnd_me', outcome: 'done' });
        if (path === '/v1/scoped/computer') return typeof scoped === 'function' ? scoped() : scoped;
        if (path === '/v1/scoped/computer/screen') return Response.json({ error: { code: 'E_BROWSER_NOT_FOUND', message: 'no' } }, { status: 404 });
        if (path === '/v1/handoffs/hnd_1/screen') {
          return new Response(new Blob(['jpeg']), { headers: { 'content-type': 'image/jpeg', 'x-husk-viewport': '1280x720' } });
        }
        return Response.json({ error: { code: 'E_ROUTE_NOT_FOUND', message: 'no' } }, { status: 404 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says it is running, with its label as text, when nothing needs the person', async () => {
    scoped = () => Response.json({ computerId: 'cmp_1', state: 'running', label: '<b>Claude Desktop</b> · chat started 10:42', handoff: null });
    const { container } = render(<LinkedComputer />);
    expect(await screen.findByText('Computer running')).toBeTruthy();
    expect(screen.getByText('<b>Claude Desktop</b> · chat started 10:42')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(await screen.findByText('No browser is open on this computer.')).toBeTruthy();
  });

  it('shows an ssh or fly computer’s screen only when asked, since every picture is a command on it', async () => {
    scoped = () => Response.json({ computerId: 'cmp_1', state: 'running', provider: 'fly', handoff: null });
    const screens = () => vi.mocked(globalThis.fetch).mock.calls.filter(([u]) => new URL(String(u)).pathname === '/v1/scoped/computer/screen').length;
    render(<LinkedComputer />);
    expect(await screen.findByText(/shows when you look/)).toBeTruthy();
    expect(screens()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Look' }));
    expect(await screen.findByText('No browser is open on this computer.')).toBeTruthy();
    expect(screens()).toBe(1);
  });

  it('becomes the take-over view when a handoff is waiting on it', async () => {
    scoped = () => Response.json({ computerId: 'cmp_1', state: 'running', handoff });
    render(<LinkedComputer />);
    expect(await screen.findByText(REASON)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('shows a later handoff on the same computer after the person finished the first', async () => {
    let current: typeof handoff | null = handoff;
    scoped = () => Response.json({ computerId: 'cmp_1', state: 'running', handoff: current });
    const realFetch = globalThis.fetch as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      if (new URL(input).pathname === '/v1/handoffs/hnd_1/done') {
        current = null;
        return Response.json({ handoffId: 'hnd_1', outcome: 'done' });
      }
      return realFetch(input, init);
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<LinkedComputer />);
      fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Yes, hand back to the agent' }));
      expect(await screen.findByText('Handed back to the chat')).toBeTruthy();
      // The model hands off again: a new handoff on the same computer.
      current = { ...handoff, handoffId: 'hnd_2', reason: 'Enter the 2FA code.' };
      await vi.advanceTimersByTimeAsync(3500);
      expect(await screen.findByText('Enter the 2FA code.')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the computer from the link, and gives it back without losing the link', async () => {
    let current: unknown = null;
    scoped = () => Response.json({ computerId: 'cmp_1', state: 'running', handoff: current });
    render(<LinkedComputer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    expect(await screen.findByText('You have this computer')).toBeTruthy();
    expect(posts).toEqual(['/v1/scoped/computer/takeover']);
    expect(screen.getByLabelText('Type into the page')).toBeTruthy();
    current = { handoffId: 'hnd_me', runId: 'person', husk: 'you', reason: 'You took over this computer', computerId: 'cmp_1', createdAt: '' };
    // The person's own hold: Give back needs no second question.
    fireEvent.click(screen.getByRole('button', { name: 'Give back' }));
    expect(await screen.findByText('Handed back to the chat')).toBeTruthy();
    expect(posts).toEqual(['/v1/scoped/computer/takeover', '/v1/handoffs/hnd_me/done']);
    expect(screen.getByRole('button', { name: 'Take over' })).toBeTruthy();
  });

  it('says plainly when the link has expired', async () => {
    scoped = () => Response.json({ error: { code: 'E_COMPUTER_NOT_FOUND', message: 'no computer with that link' } }, { status: 404 });
    render(<LinkedComputer />);
    expect(await screen.findByText('This link has expired')).toBeTruthy();
  });
});
