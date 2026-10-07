import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { createWorkspaceViewer } from './workspace-viewer.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function viewer() {
  const root = await mkdtemp(join(tmpdir(), 'husk-viewer-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Husk workspace</title>');
  const store = new WorkspaceStore({ root: join(root, 'data'), fetchSource: async (url) => ({ finalUrl: url, title: 'Source', content: 'Some evidence', contentType: 'text/plain', truncated: false }) });
  const setProfile = vi.fn(async () => {});
  const { app } = await createWorkspaceViewer({ store, token: 'test-secret', consoleDir: root, setProfile });
  cleanups.push(() => app.close());
  const headers = { authorization: 'Bearer test-secret', host: '127.0.0.1' };
  return { app, store, headers, setProfile };
}

describe('authenticated workspace companion', () => {
  it('serves the UI but protects data, rejects cross-origin requests and hostile hosts', async () => {
    const { app, headers } = await viewer();
    const index = await app.inject({ url: '/', headers: { host: '127.0.0.1' } });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await app.inject({ url: '/v1/workspaces', headers: { host: '127.0.0.1' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/workspaces', headers: { ...headers, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/v1/workspaces', headers: { ...headers, host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/v1/workspaces', headers })).json()).toEqual({ workspaces: [] });
  });

  it('captures a source, saves output, downloads and exports it, and requires a deletion name', async () => {
    const { app, headers } = await viewer();
    const workspace = (await app.inject({ method: 'POST', url: '/v1/workspaces', headers, payload: { name: 'Brief' } })).json();
    const prefix = `/v1/workspaces/${workspace.id}`;
    const capture = (await app.inject({ method: 'POST', url: `${prefix}/sources`, headers, payload: { url: 'https://example.com' } })).json();
    expect(capture.content).toBe('Some evidence');
    const written = await app.inject({ method: 'PUT', url: `${prefix}/files`, headers, payload: { path: 'brief.md', content: '# Brief', sourceIds: [capture.source.id] } });
    expect(written.statusCode).toBe(200);
    expect((await app.inject({ url: `${prefix}/download?path=outputs%2Fbrief.md`, headers })).body).toBe('# Brief');
    const zip = await app.inject({ url: `${prefix}/export`, headers });
    expect(zip.headers['content-type']).toContain('application/zip');
    expect(zip.rawPayload.readUInt32LE(0)).toBe(0x04034b50);
    expect((await app.inject({ method: 'DELETE', url: prefix, headers, payload: { confirmName: 'wrong' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: prefix, headers, payload: { confirmName: 'Brief' } })).statusCode).toBe(200);
    expect((await app.inject({ url: prefix, headers })).statusCode).toBe(404);
  });

  it('rejects malformed bodies, unsafe paths, and unconfirmed profile changes', async () => {
    const { app, headers, store, setProfile } = await viewer();
    const workspace = await store.create('Test');
    expect((await app.inject({ method: 'POST', url: '/v1/workspaces', headers, payload: { name: 12 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/v1/workspaces/${workspace.id}/files`, headers, payload: { path: '../secret', content: 'escape' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/profile', headers, payload: { profile: 'computer' } })).statusCode).toBe(400);
    expect(setProfile).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/v1/profile', headers, payload: { profile: 'computer', confirm: true } })).statusCode).toBe(200);
    expect(setProfile).toHaveBeenCalledWith('computer');
  });
});
