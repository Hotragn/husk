import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App';

describe('starter viewer shell', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); window.localStorage.clear(); window.history.replaceState(null, '', '/'); });

  it('uses the link token on the current origin and never opens advanced endpoints', async () => {
    window.localStorage.setItem('husk.console.baseUrl', 'https://old-server.example');
    window.history.replaceState(null, '', '/#token=private-test-token');
    const requests: string[] = [];
    const socket = vi.fn();
    vi.stubGlobal('WebSocket', socket);
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      requests.push(String(input));
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-test-token');
      const url = new URL(input);
      expect(url.origin).toBe(window.location.origin);
      if (url.pathname === '/health') return Response.json({ ok: true, mode: 'starter', profile: 'starter', version: 'test' });
      if (url.pathname === '/v1/workspaces') return Response.json({ workspaces: [] });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));
    render(<App />);
    expect(await screen.findByText('Start with a small task.')).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(socket).not.toHaveBeenCalled();
    expect(requests.some((url) => url.includes('computers'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
  });
});
