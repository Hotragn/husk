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
  beforeEach(() => {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const path = new URL(input).pathname;
        requests.push(path);
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

  it('says not available rather than inventing numbers, and shows no thumbnail without a browser', async () => {
    const { container } = render(<OverviewPanel onOpen={() => {}} />);
    expect((await screen.findAllByText('CPU not available · memory not available · disk not available')).length).toBeGreaterThan(0);
    expect(container.querySelector('.overview-thumb')).toBeNull();
  });
});
