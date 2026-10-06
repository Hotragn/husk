import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApi } from './workspaces';

describe('workspace transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('authenticates file downloads and escapes paths without exposing credentials in URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('saved output'));
    vi.stubGlobal('fetch', fetchMock);
    const api = new WorkspaceApi('http://127.0.0.1:7777/', 'private-token');
    expect((await api.download('work 1', 'notes/a & b.md')).size).toBe(12);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:7777/v1/workspaces/work%201/download?path=notes%2Fa+%26+b.md');
    expect(init.headers.get('authorization')).toBe('Bearer private-token');
    expect(url).not.toContain('private-token');
  });

  it('shows the selected provider isolation without treating local guardrails as a sandbox', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ providers: [], selected: { name: 'local', available: true, isolationKind: 'guardrails', reason: 'Uses this device' } })));
    expect(await new WorkspaceApi('http://localhost', '').capabilities()).toEqual({ provider: 'local', available: true, isolationKind: 'guardrails', reason: 'Uses this device' });
  });

  it('includes the typed name in a delete request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await new WorkspaceApi('http://localhost', 'test').remove('id', 'Travel research');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost/v1/workspaces/id');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ confirmName: 'Travel research' });
  });
});
