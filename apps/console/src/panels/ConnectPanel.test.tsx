import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HuskApi } from '../api/client';
import type { SetupState } from '../api/wire';
import { ConnectPanel } from './ConnectPanel';

const api = new HuskApi({ baseUrl: 'http://localhost:7377', token: 'test-token' });
vi.mock('../state/connection', () => ({ useConnection: () => ({ api, revision: 0, invalidate: () => {} }) }));

const state: SetupState = {
  computers: [
    { name: 'docker', description: 'a container per computer', available: true, isolated: true },
    { name: 'podman', description: 'rootless containers', available: false, reason: 'the podman CLI is not on PATH', hint: 'install Podman Desktop' },
    { name: 'local', description: 'a guarded folder', available: true, isolated: false },
  ],
  apps: [
    { id: 'claude-desktop', name: 'Claude Desktop', found: true, connected: false, where: 'C:/Users/me/AppData/Roaming/Claude/claude_desktop_config.json', after: 'Restart it.' },
    { id: 'cursor', name: 'Cursor', found: true, connected: true, where: '/home/me/.cursor/mcp.json', after: '' },
    { id: 'windsurf', name: 'Windsurf', found: false, connected: false, where: '/home/me/.codeium/windsurf/mcp_config.json', after: '' },
  ],
};

let calls: Array<{ method: string; path: string; body?: unknown }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      calls.push({ method: init?.method ?? 'GET', path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === '/v1/setup') return Response.json(state);
      if (path === '/v1/setup/apps/claude-desktop')
        return Response.json({ id: 'claude-desktop', ok: true, message: 'added to Claude Desktop. Restart it.', backup: 'C:/x.husk-backup' });
      if (path === '/v1/setup/test') return Response.json({ ok: true, provider: 'docker', output: 'Linux 6.6', ms: 2400 });
      return Response.json({ error: { code: 'E_ROUTE_NOT_FOUND', message: 'no' } }, { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Connect panel', () => {
  it('gives a prompt a chat can set Husk up with, for one app or every one', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<ConnectPanel />);
    await screen.findByText('Claude Desktop', { selector: 'strong' });
    const box = screen.getByRole('textbox', { name: 'Setup prompt' }) as HTMLTextAreaElement;
    expect(box.value).toContain('npx -y @husk-ai/cli@~0.2 setup --computer auto --apps all --yes');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'claude-desktop' } });
    expect(box.value).toContain('--apps claude-desktop --yes');
    expect(box.value).toContain('Tell me to restart Claude Desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(writeText).toHaveBeenCalledWith(box.value);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('recommends the isolated computer, and explains the ones that are not available', async () => {
    render(<ConnectPanel />);
    const docker = (await screen.findByDisplayValue('docker')) as HTMLInputElement;
    expect(docker.checked).toBe(true);
    expect((screen.getByDisplayValue('podman') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/install Podman Desktop/)).toBeTruthy();
  });

  it('connects an app with the chosen computer and a browser, and shows the backup', async () => {
    render(<ConnectPanel />);
    await screen.findByText('Claude Desktop', { selector: 'strong' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Claude Desktop' }));
    expect(await screen.findByText(/Backup: C:\/x.husk-backup/)).toBeTruthy();
    expect(calls.find((c) => c.path === '/v1/setup/apps/claude-desktop')?.body).toEqual({ provider: 'docker', flavor: 'full' });
  });

  it('offers no Connect for an app that is not on this machine', async () => {
    render(<ConnectPanel />);
    await screen.findByText('Windsurf', { selector: 'strong' });
    expect(screen.queryByRole('button', { name: 'Connect Windsurf' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect again Cursor' })).toBeTruthy();
  });

  it('runs a test on the chosen computer', async () => {
    render(<ConnectPanel />);
    await screen.findByText('Claude Desktop', { selector: 'strong' });
    fireEvent.click(screen.getByRole('button', { name: 'Test this computer' }));
    expect(await screen.findByText(/docker answered in 2.4 s/)).toBeTruthy();
  });
});
