import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HomePanel } from './HomePanel';

vi.mock('../state/connection', () => ({ useConnection: () => ({ baseUrl: 'http://localhost', token: 'test-token', health: { mode: 'starter', profile: 'starter' }, status: 'connected', revision: 0, retryNow: vi.fn() }) }));

const manifest = { version: 1, id: 'ws-one', name: 'Travel research', createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z', sources: [{ id: 'src-1', url: 'https://example.org/guide', finalUrl: 'https://example.org/guide', title: 'A travel guide', fetchedAt: '2026-10-05T12:00:00Z', excerpt: 'A captured source.', sha256: 'hash', path: 'sources/guide.md', truncated: false, contentType: 'text/html' }], files: [{ path: 'brief.md', sizeBytes: 42, updatedAt: '2026-10-05T12:00:00Z', sourceIds: ['src-1'] }] };

describe('workspace Home', () => {
  let requests: Array<{ path: string; method: string; body?: unknown }>;
  beforeEach(() => {
    requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      const path = new URL(input).pathname;
      requests.push({ path, method: init.method ?? 'GET', ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === '/v1/workspaces') return Response.json({ workspaces: [{ id: manifest.id, name: manifest.name, updatedAt: manifest.updatedAt, sourceCount: 1, fileCount: 1 }] });
      if (path === '/v1/workspaces/ws-one/files') return Response.json({ path: new URL(input).searchParams.get('path'), content: '# Saved result', sourceIds: ['src-1'] });
      if (path === '/v1/capabilities') return Response.json({ providers: [], selected: { name: 'local', available: true, isolationKind: 'guardrails' } });
      if (path === '/v1/profile') return Response.json({ profile: 'computer' });
      return Response.json(manifest);
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('opens saved work, gives an actionable prompt, and previews output', async () => {
    render(<HomePanel />);
    await screen.findByText('A travel guide');
    const prompt = screen.getByLabelText('Prompt to paste into your AI app') as HTMLTextAreaElement;
    expect(prompt.value).toContain('Travel research');
    expect(prompt.value).toContain('workspace_write');
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(await screen.findByText('# Saved result')).toBeTruthy();
    expect(requests.some((request) => request.path.includes('computers'))).toBe(false);
  });

  it('requires the exact workspace name before deletion', async () => {
    render(<HomePanel />);
    await screen.findByText('A travel guide');
    fireEvent.click(screen.getByText('Workspace settings'));
    const button = screen.getByRole('button', { name: 'Delete workspace' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type “Travel research” to confirm'), { target: { value: 'Wrong name' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type “Travel research” to confirm'), { target: { value: 'Travel research' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE' && (request.body as { confirmName: string }).confirmName === 'Travel research')).toBe(true));
  });

  it('requires acknowledgement of the actual environment before enabling computer tools', async () => {
    render(<HomePanel />);
    const disclosure = screen.getByText('Advanced · computer tools').parentElement as HTMLDetailsElement;
    disclosure.open = true;
    fireEvent(disclosure, new Event('toggle'));
    expect(await screen.findByText('Runs on this device without a sandbox')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Enable computer tools' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);
    await waitFor(() => expect(requests.some((request) => request.path === '/v1/profile' && request.method === 'POST')).toBe(true));
  });
});
