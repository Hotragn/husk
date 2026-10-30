import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HuskApi } from '../api/client';
import { ComputersPanel } from './ComputersPanel';

const api = new HuskApi({ baseUrl: 'http://localhost:7377', token: 'test-token' });
vi.mock('../state/connection', () => ({ useConnection: () => ({ api, revision: 0, invalidate: () => {} }) }));

const chatComputer = {
  id: 'cmp_chat1',
  name: 'mcp-x',
  provider: 'local',
  state: 'stopped',
  image: 'host',
  workdir: '/work',
  createdAt: '2026-10-19T09:00:00Z',
  lastUsedAt: '2026-10-19T10:42:00Z',
  spec: { labels: { 'husk.via': 'mcp' } },
  platform: 'Claude Desktop',
  chatLabel: 'Claude Desktop · chat started 10:42',
  identitySource: 'first-call',
};
vi.mock('../state/computers', () => ({
  useComputers: () => ({ list: [chatComputer], loaded: true, loading: false, error: null, reload: () => {}, showSkeleton: false, slow: false }),
}));

describe('Computers panel', () => {
  let requests: Array<{ method: string; url: string }>;

  beforeEach(() => {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search });
        if (url.pathname === '/v1/computers/cmp_chat1/disk') return Response.json({ bytes: 5 * 1024 * 1024 });
        if (init.method === 'DELETE') return new Response(null, { status: 204 });
        if (url.pathname === '/v1/doctor') return Response.json({ providers: [] });
        return Response.json({ error: { code: 'E_ROUTE_NOT_FOUND', message: 'no' } }, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each computer's app, chat label, last used time and disk size", async () => {
    render(<ComputersPanel activeId={null} onSelect={() => {}} />);
    // The app's mark in the husk, the same as the desktop window's tabs and the notch.
    expect(screen.getByText('Claude Desktop').querySelector('svg.glyph-husk')).toBeTruthy();
    expect(screen.getByText('Claude Desktop · chat started 10:42')).toBeTruthy();
    expect(await screen.findByText('5.0 MiB')).toBeTruthy();
  });

  it('deletes nothing when the person cancels the confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    render(<ComputersPanel activeId={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete cmp_chat1' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('deletes with the id typed back once the person confirms, erasing its files and browser logins', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    render(<ComputersPanel activeId={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete cmp_chat1' }));
    expect(String(confirm.mock.calls[0]?.[0])).toContain('Claude Desktop · chat started 10:42');
    expect(String(confirm.mock.calls[0]?.[0])).toContain('browser’s logins');
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE')).toBe(true));
    expect(requests.find((r) => r.method === 'DELETE')?.url).toBe('/v1/computers/cmp_chat1?confirm=cmp_chat1&erase=true');
  });
});
