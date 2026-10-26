import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HuskApi } from '../api/client';
import type { RemoteStatus, SetupState } from '../api/wire';
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
    { id: 'gemini', name: 'Gemini CLI', found: true, connected: true, outdated: true, where: '/home/me/.gemini/settings.json', after: '' },
  ],
};

const onRemotely: RemoteStatus = {
  on: true,
  publicUrl: 'https://husk.tail1234.ts.net',
  endpoint: 'https://husk.tail1234.ts.net/mcp',
  owner: false,
  apps: [{ id: 'app1', name: 'Claude', createdAt: '2026-10-26T10:00:00.000Z' }],
  advisories: [],
};

let calls: Array<{ method: string; path: string; body?: unknown }>;
let remote: RemoteStatus | null;
beforeEach(() => {
  calls = [];
  remote = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      calls.push({ method: init?.method ?? 'GET', path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === '/v1/setup') return Response.json(state);
      if (remote && path === '/v1/remote') return Response.json(remote);
      if (remote && path === '/v1/remote/claim') return Response.json({ code: 'ABCD-EFGH-JKMN-PQRS' });
      if (remote && path === '/v1/remote/off') return Response.json((remote = { ...remote, on: false, offReason: 'Switched off in the console.', apps: [] }));
      if (remote && path === '/v1/remote/on')
        return Response.json({ error: { code: 'E_CONFIG', message: 'a high or critical advisory stands', hint: 'upgrade Husk' } }, { status: 409 });
      if (remote && path === '/v1/remote/apps/app1') return Response.json((remote = { ...remote, apps: [] }));
      if (path === '/v1/setup/apps/claude-desktop')
        return Response.json({ id: 'claude-desktop', ok: true, message: 'added to Claude Desktop. Restart it.', backup: 'C:/x.husk-backup' });
      if (path === '/v1/setup/test') return Response.json({ ok: true, provider: 'docker', output: 'Linux 6.6', ms: 2400 });
      if (path === '/v1/setup/apps/gemini') return Response.json({ id: 'gemini', ok: true, message: 'added to Gemini CLI.' });
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

  it('offers Update for an app whose Husk is older, and moves it with the chosen computer', async () => {
    render(<ConnectPanel />);
    await screen.findByText('Gemini CLI', { selector: 'strong' });
    expect(screen.getByText('older Husk')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update Gemini CLI' }));
    expect(await screen.findByText('added to Gemini CLI.')).toBeTruthy();
    expect(calls.find((c) => c.path === '/v1/setup/apps/gemini')?.body).toEqual({ provider: 'docker', flavor: 'full' });
  });

  it('says how to reach this Husk from the web when remote access is not started', async () => {
    render(<ConnectPanel />);
    expect(await screen.findByText(/husk serve --remote --public-url/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How to set it up' }).getAttribute('href')).toContain('remote-access');
  });

  it('gives a claim code, signs an app out, and switches remote access off only once confirmed', async () => {
    remote = { ...onRemotely };
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<ConnectPanel />);
    expect(await screen.findByText('Remote access on')).toBeTruthy();
    expect(screen.getByText('https://husk.tail1234.ts.net/mcp')).toBeTruthy();
    expect(screen.getByText(/The chat app sees everything the tools return/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Make a claim code' }));
    expect(await screen.findByText('ABCD-EFGH-JKMN-PQRS')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out Claude' }));
    expect(await screen.findByText('No app is signed in.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/remote/apps/app1')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    expect(confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.path === '/v1/remote/off')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    expect(await screen.findByText('Switched off in the console.')).toBeTruthy();
    expect(screen.getByText('Remote access off')).toBeTruthy();
  });

  it('shows the advisory that keeps remote access off, and the refusal to switch it on', async () => {
    remote = {
      ...onRemotely,
      on: false,
      owner: true,
      apps: [],
      offReason: 'A critical advisory switched remote access off.',
      advisories: [{ name: 'minimist', version: '1.2.5', title: 'Prototype Pollution in minimist', severity: 'critical', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', vulnerable: '<1.2.6' }],
    };
    render(<ConnectPanel />);
    expect(await screen.findByText('A critical advisory switched remote access off.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Prototype Pollution in minimist' }).getAttribute('href')).toBe('https://github.com/advisories/GHSA-xvch-5gv4-984h');
    expect(screen.getByText(/stays off until Husk is upgraded/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch on' }));
    expect(await screen.findByText('a high or critical advisory stands')).toBeTruthy();
  });

  it('runs a test on the chosen computer', async () => {
    render(<ConnectPanel />);
    await screen.findByText('Claude Desktop', { selector: 'strong' });
    fireEvent.click(screen.getByRole('button', { name: 'Test this computer' }));
    expect(await screen.findByText(/docker answered in 2.4 s/)).toBeTruthy();
  });
});
