import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

let harness: TestApp | undefined;
let home = '';
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
});

// Every test edits a temporary home, never the real one.
describe('the Connect page routes', { timeout: 30_000 }, () => {
  it('lists the apps found in its home and the computers', async () => {
    home = mkdtempSync(join(tmpdir(), 'husk-connect-'));
    mkdirSync(join(home, '.cursor'), { recursive: true });
    harness = await buildTestApp({ chatAppsHome: home });
    const body = (await harness.app.inject({ method: 'GET', url: '/v1/setup' })).json();
    expect(body.apps.find((a: { id: string }) => a.id === 'cursor')).toMatchObject({ found: true, connected: false });
    expect(body.computers[0]).toMatchObject({ name: 'local' });
  });

  it('connects an app with the chosen computer, and disconnects it', async () => {
    home = mkdtempSync(join(tmpdir(), 'husk-connect-'));
    mkdirSync(join(home, '.cursor'), { recursive: true });
    harness = await buildTestApp({ chatAppsHome: home });
    const r = (await harness.app.inject({ method: 'POST', url: '/v1/setup/apps/cursor', payload: { provider: 'docker', flavor: 'full' } })).json();
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.husk.args).toEqual([
      '-y', '@husk-ai/mcp', '--provider', 'docker', '--flavor', 'full',
    ]);
    expect((await harness.app.inject({ method: 'DELETE', url: '/v1/setup/apps/cursor' })).json().ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers).toEqual({});
  });

  it('refuses an app it does not know and a computer name that is not a plain word', async () => {
    home = mkdtempSync(join(tmpdir(), 'husk-connect-'));
    harness = await buildTestApp({ chatAppsHome: home });
    expect((await harness.app.inject({ method: 'POST', url: '/v1/setup/apps/chatgpt', payload: {} })).statusCode).toBe(404);
    expect((await harness.app.inject({ method: 'POST', url: '/v1/setup/apps/cursor', payload: { provider: '--rm -rf' } })).statusCode).toBe(422);
  });

  it('tests a computer by running one command and removing it', async () => {
    home = mkdtempSync(join(tmpdir(), 'husk-connect-'));
    harness = await buildTestApp({ chatAppsHome: home });
    const r = (await harness.app.inject({ method: 'POST', url: '/v1/setup/test', payload: {} })).json();
    expect(r).toMatchObject({ ok: true });
    expect(harness.manager.computers.size).toBe(0);
  });
});
