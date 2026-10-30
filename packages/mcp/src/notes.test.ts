import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { WorkspaceStore } from '@husk-ai/workspaces';
import type { ComputerManager } from '@husk-ai/runtime';
import { HuskMcpServer } from './server.js';
import type { HuskMcpOptions } from './server.js';

let dir = '';
let notesDir = '';
const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'husk-mcp-notes-'));
  notesDir = join(dir, 'bots', 'nightly', 'memory');
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A bot's MCP server, as its CLI engine starts it: the environment says which notes are its. */
async function connect(env: Record<string, string>, opts: HuskMcpOptions = {}) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const create = vi.fn(async () => {
    throw new Error('notes need no computer');
  });
  const server = new HuskMcpServer({ manager: { create } as unknown as ComputerManager, workspaceStore: new WorkspaceStore({ root: join(dir, 'workspaces') }), daemon: false, ...opts });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.server.connect(b)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const names = async () => (await client.listTools()).tools.map((t) => t.name);
  const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as Array<{ text: string }>)[0]!.text;
  return { client, create, names, text };
}

describe("a bot's notes over MCP", () => {
  it('offers a bot that keeps notes the memory tool beside its computer', async () => {
    const { client, create, names, text } = await connect({ HUSK_MEMORY_DIR: notesDir });
    expect(await names()).toEqual(expect.arrayContaining(['memory', 'shell']));
    const saved = await client.callTool({ name: 'memory', arguments: { command: 'create', path: '/memories/prefs.md', file_text: 'Reply in French.' } });
    expect(saved.isError).not.toBe(true);
    expect(text(saved)).toBe('Saved prefs.md.');
    expect(readFileSync(join(notesDir, 'prefs.md'), 'utf8')).toBe('Reply in French.');

    const outside = await client.callTool({ name: 'memory', arguments: { command: 'view', path: '../../secret' } });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toContain('use a plain name inside it');
    expect(create).not.toHaveBeenCalled();
  });

  it('offers a bot with no computer its notes and nothing else', async () => {
    const { client, create, names } = await connect({ HUSK_MEMORY_DIR: notesDir, HUSK_MEMORY_ONLY: '1' });
    expect(await names()).toEqual(['memory']);
    expect(client.getInstructions()).toContain('memory');
    expect((await client.callTool({ name: 'shell', arguments: { command: 'ls' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'workspace_list', arguments: {} })).isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('offers no notes to a chat, or to a remote app on a machine a bot left its notes folder in', async () => {
    expect(await (await connect({})).names()).not.toContain('memory');
    const remote = await connect({ HUSK_MEMORY_DIR: notesDir }, { remote: { owner: 'someone', platform: 'claude' } });
    expect(await remote.names()).not.toContain('memory');
    await remote.client.callTool({ name: 'memory', arguments: { command: 'create', path: 'x.md', file_text: 'x' } });
    expect(existsSync(notesDir)).toBe(false);
  });
});
