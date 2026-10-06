import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceStore } from '@husk-ai/workspaces';
import type { ComputerManager } from '@husk-ai/runtime';
import { HuskMcpServer } from './server.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(root?: string, profile: 'starter' | 'computer' = 'starter') {
  if (!root) {
    root = await mkdtemp(join(tmpdir(), 'husk-mcp-workspace-'));
    const dir = root;
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
  }
  const create = vi.fn(async () => { throw new Error('Computer must not be created for workspace tools'); });
  const workspaceStore = new WorkspaceStore({ root });
  const server = new HuskMcpServer({ profile, workspaceStore, manager: { create } as unknown as ComputerManager });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.server.connect(b)]);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  return { root, client, server, create, call };
}

describe('workspace MCP profile', () => {
  it('saves and reopens a file in a fresh session without creating a computer', async () => {
    const first = await setup();
    const tools = (await first.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('workspace_create');
    expect(tools).not.toContain('shell');
    const workspace = await first.call('workspace_create', { name: 'Research' });
    await first.call('workspace_write', { path: 'brief.md', content: '# Saved' });
    const second = await setup(first.root);
    expect((await second.call('workspace_open', { name: 'research' })).id).toBe(workspace.id);
    expect((await second.call('workspace_read', { path: 'outputs/brief.md' })).content).toBe('# Saved');
    expect(first.create).not.toHaveBeenCalled();
    expect(second.create).not.toHaveBeenCalled();
  });

  it('enforces starter restrictions even if a client directly calls a hidden tool', async () => {
    const session = await setup();
    const result = await session.client.callTool({ name: 'shell', arguments: { command: 'touch file' } });
    expect(result.isError).toBe(true);
    expect(session.create).not.toHaveBeenCalled();
  });

  it('retains computer tools on the existing default profile and requires workspace selection', async () => {
    const session = await setup(undefined, 'computer');
    expect((await session.client.listTools()).tools.map((t) => t.name)).toContain('shell');
    expect((await session.client.callTool({ name: 'workspace_write', arguments: { path: 'a.md', content: 'a' } })).isError).toBe(true);
    expect(session.create).not.toHaveBeenCalled();
  });
});
