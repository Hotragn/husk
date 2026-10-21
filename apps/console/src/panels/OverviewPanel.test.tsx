import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { HuskApi } from '../api/client';
import type { Overview } from '../api/wire';
import { OverviewPanel, sortRows } from './OverviewPanel';

const api = new HuskApi({ baseUrl: 'http://localhost:7377', token: 'test-token' });
vi.mock('../state/connection', () => ({ useConnection: () => ({ api, revision: 0, invalidate: () => {} }) }));

const base = { image: 'x', workdir: '/work', spec: {}, provider: 'docker' as const };
const computer = (id: string, state: 'running' | 'stopped', lastUsedAt: string, extra = {}) =>
  ({ id, name: id, state, createdAt: lastUsedAt, lastUsedAt, ...base, ...extra }) as Overview['computers'][number];

const REASON = '<img src=x onerror="alert(1)"> Sign in to example.com';
const overview: Overview = {
  computers: [
    computer('cmp_idle', 'running', '2026-10-20T09:00:00Z', { chatLabel: 'Cursor · chat started 09:00', platform: 'Cursor' }),
    computer('cmp_stopped', 'stopped', '2026-10-19T09:00:00Z'),
    computer('cmp_busy', 'running', '2026-10-20T08:00:00Z'),
    computer('cmp_wait', 'running', '2026-10-20T07:00:00Z', { chatLabel: 'Claude Desktop · chat started 07:00', platform: 'Claude Desktop' }),
  ],
  activeRuns: [{ runId: 'run_1', husk: 'triage', startedAt: '', computerId: 'cmp_busy', step: 2, tool: 'shell' }],
  handoffs: [{ handoffId: 'hnd_1', runId: 'run_2', husk: 'chat', reason: REASON, computerId: 'cmp_wait', createdAt: '' }],
};

describe('sortRows', () => {
  it('puts waiting first, then busy, then idle by most recent use', () => {
    expect(sortRows(overview).map((r) => r.computer.id)).toEqual(['cmp_wait', 'cmp_busy', 'cmp_idle', 'cmp_stopped']);
  });
});

describe('Overview panel', () => {
  let requests: string[];
  let sockets: string[];
  beforeEach(() => {
    requests = [];
    sockets = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        onmessage = null;
        onclose = null;
        constructor(url: string) {
          sockets.push(new URL(url).pathname + new URL(url).search.replace(/[?&]token=[^&]*/, ''));
        }
        close() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname;
        requests.push(init?.method && init.method !== 'GET' ? `${init.method} ${path}` : path);
        if (path.endsWith('/takeover')) return Response.json({ handoffId: 'hnd_me', runId: 'person', husk: 'you', reason: 'x', computerId: 'cmp_idle', createdAt: '' }, { status: 201 });
        if (path.endsWith('/done')) return Response.json({ handoffId: 'hnd_me', outcome: 'done' });
        if (path === '/v1/overview') return Response.json(overview);
        if (path === '/v1/doctor') return Response.json({ providers: [{ name: 'docker', available: true, isolated: true, isolationKind: 'container' }] });
        if (path.endsWith('/stats')) return Response.json({ cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, diskBytes: null, notes: ['x'] });
        if (path.endsWith('/thumbnail')) return Response.json({ error: { code: 'E_BROWSER_NOT_FOUND', message: 'no' } }, { status: 404 });
        return Response.json({ error: { code: 'E_ROUTE_NOT_FOUND', message: 'no' } }, { status: 404 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sums up running, waiting and stopped', async () => {
    const { container } = render(<OverviewPanel onOpen={() => {}} />);
    await screen.findByText('Running triage · step 2 · shell');
    const text = container.querySelector('.overview-summary')?.textContent ?? '';
    expect(text.replace(/\s+/g, ' ')).toBe('3 running · 1 waiting on you · 1 stopped');
  });

  it('shows what each computer is doing, with the waiting reason as text', async () => {
    const { container } = render(<OverviewPanel onOpen={() => {}} />);
    expect(await screen.findByText('Running triage · step 2 · shell')).toBeTruthy();
    expect(screen.getByText(REASON)).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText('Cursor · chat started 09:00')).toBeTruthy();
  });

  it('takes over and opens Terminal, Files and Browser on the right computer', async () => {
    const onOpen = vi.fn();
    render(<OverviewPanel onOpen={onOpen} />);
    const waiting = await screen.findByRole('article', { name: 'Claude Desktop · chat started 07:00' });
    fireEvent.click(within(waiting).getByRole('button', { name: 'Take over' }));
    fireEvent.click(within(waiting).getByRole('button', { name: 'Terminal' }));
    expect(onOpen.mock.calls).toEqual([
      ['handoffs', 'cmp_wait'],
      ['terminal', 'cmp_wait'],
    ]);
  });

  it('says not available rather than inventing numbers', async () => {
    render(<OverviewPanel onOpen={() => {}} />);
    expect((await screen.findAllByText('CPU not available · memory not available · disk not available')).length).toBeGreaterThan(0);
  });

  it('looks at an idle computer’s browser only when asked, since a frame counts as using the computer', async () => {
    const { container } = render(<OverviewPanel onOpen={() => {}} />);
    await screen.findByText('Running triage · step 2 · shell');
    expect(requests.some((p) => p.endsWith('/thumbnail'))).toBe(false);
    const idle = screen.getByRole('article', { name: 'Cursor · chat started 09:00' });
    fireEvent.click(within(idle).getByRole('button', { name: 'Look at browser' }));
    expect(await within(idle).findByText('No browser is open on this computer.')).toBeTruthy();
    expect(requests.filter((p) => p.endsWith('/thumbnail'))).toEqual(['/v1/computers/cmp_idle/thumbnail']);
    expect(container.querySelector('.overview-thumb')).toBeNull();
  });

  it('shows the screen live, slowly, only on computers in use', async () => {
    render(<OverviewPanel onOpen={() => {}} />);
    await screen.findByText('Running triage · step 2 · shell');
    expect(sockets.sort()).toEqual(['/v1/computers/cmp_busy/screen?fps=1', '/v1/computers/cmp_wait/screen?fps=1']);
  });

  it('takes an idle computer at any moment, and gives it back', async () => {
    const onOpen = vi.fn();
    render(<OverviewPanel onOpen={onOpen} />);
    const idle = await screen.findByRole('article', { name: 'Cursor · chat started 09:00' });
    fireEvent.click(within(idle).getByRole('button', { name: 'Take over' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('handoffs', 'cmp_idle'));
    expect(requests).toContain('POST /v1/computers/cmp_idle/takeover');

    overview.handoffs.push({ handoffId: 'hnd_me', runId: 'person', husk: 'you', reason: 'x', computerId: 'cmp_idle', createdAt: '' });
    try {
      cleanup();
      render(<OverviewPanel onOpen={onOpen} />);
      const held = await screen.findByRole('article', { name: 'Cursor · chat started 09:00' });
      expect(within(held).getByText('You have this computer')).toBeTruthy();
      fireEvent.click(within(held).getByRole('button', { name: 'Give back' }));
      await vi.waitFor(() => expect(requests).toContain('POST /v1/handoffs/hnd_me/done'));
    } finally {
      overview.handoffs.pop();
    }
  });

  it('shows a handoff that has no computer card, with Take over', async () => {
    const onOpen = vi.fn();
    overview.handoffs.push({ handoffId: 'hnd_9', runId: 'run_9', husk: 'billing', reason: 'Approve the payment.', createdAt: '' });
    try {
      render(<OverviewPanel onOpen={onOpen} />);
      const block = (await screen.findByText('Approve the payment.')).closest('.overview-waiting') as HTMLElement;
      fireEvent.click(within(block).getByRole('button', { name: 'Take over' }));
      expect(onOpen).toHaveBeenCalledWith('handoffs', '');
    } finally {
      overview.handoffs.pop();
    }
  });

  it('counts computers in other states so the summary adds up', async () => {
    overview.computers.push(computer('cmp_err', 'error' as never, '2026-10-20T06:00:00Z'));
    try {
      const { container } = render(<OverviewPanel onOpen={() => {}} />);
      await screen.findByText('Running triage · step 2 · shell');
      expect(container.querySelector('.overview-summary')?.textContent?.replace(/\s+/g, ' ')).toBe(
        '3 running · 1 waiting on you · 1 stopped · 1 other',
      );
    } finally {
      overview.computers.pop();
    }
  });
});
