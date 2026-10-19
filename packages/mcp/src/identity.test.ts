/**
 * One computer per chat, identified only by what hosts provide on purpose.
 *
 * Claude Desktop is the hard case: one server process may serve every chat, and
 * MCP does not say which chat a call came from. There the first Husk call in a
 * chat makes its computer and the chat passes the id back; anything ambiguous
 * creates nothing and asks.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Computer, ComputerSpec, Logger } from '@husk-ai/core';
import type { ComputerManager } from '@husk-ai/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HuskMcpServer } from './server.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function fakeManager() {
  const made: Computer[] = [];
  const make = async (spec: ComputerSpec) => {
    const id = `cmp_${made.length + 1}`;
    const info = {
      id,
      name: spec.name ?? id,
      provider: 'docker',
      state: 'running',
      image: 'x',
      workdir: '/work',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      spec,
    };
    const c = {
      id,
      info,
      async exec() {
        return { exitCode: 0, stdout: `on ${id}`, stderr: '', durationMs: 1, truncated: false, timedOut: false };
      },
      async refresh() {
        return info;
      },
      async destroy() {},
      async stop() {},
    } as unknown as Computer;
    made.push(c);
    return c;
  };
  return { made, manager: { create: make, ensure: async (_k: string, s: ComputerSpec) => make(s) } as unknown as ComputerManager };
}

let saved: string | undefined;
beforeEach(() => {
  // These tests may themselves run inside Claude Code.
  saved = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = saved;
});

async function connect(clientName: string) {
  const { made, manager } = fakeManager();
  const server = new HuskMcpServer({ manager, ephemeral: false, logger: silent });
  const client = new Client({ name: clientName, version: '1.0' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(s), client.connect(c)]);
  const shell = async (computer?: string) => {
    const r = (await client.callTool({
      name: 'shell',
      arguments: { command: 'echo', ...(computer !== undefined ? { computer } : {}) },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') };
  };
  return { made, client, shell, server };
}

const idIn = (text: string) => /Your computer id is (cmp_\d+)/.exec(text)?.[1] ?? '';

describe('chats that share one server process', () => {
  it('give two chats two computers, labelled by app and start time', async () => {
    const { made, shell } = await connect('claude-ai');
    const a = idIn((await shell('new')).text);
    const b = idIn((await shell('new')).text);
    expect(a).toBe('cmp_1');
    expect(b).toBe('cmp_2');
    for (const c of made) {
      expect(c.info.spec.labels?.['husk.platform']).toBe('Claude Desktop');
      expect(c.info.spec.labels?.['husk.identity']).toBe('first-call');
      expect(c.info.spec.labels?.['husk.chat']).toMatch(/^Claude Desktop · chat started \d\d:\d\d$/);
    }
  });

  it('reuse the computer a chat names', async () => {
    const { made, shell } = await connect('claude-ai');
    await shell('new');
    await shell('new');
    expect((await shell('cmp_1')).text).toContain('on cmp_1');
    expect((await shell('cmp_2')).text).toContain('on cmp_2');
    expect(made).toHaveLength(2);
  });

  it('never hand a second chat the first chat\'s computer when it names none', async () => {
    const { made, shell } = await connect('claude-ai');
    // Chat A's first call, with no id: nothing exists yet, so this can only be chat A's.
    const a = await shell();
    expect(a.text).toContain('Your computer id is cmp_1');
    // A call with no id now could be chat B's first call. It is refused, not given cmp_1.
    const b = await shell();
    expect(b.isError).toBe(true);
    expect(b.text).toContain('computer: "new"');
    expect(b.text).not.toContain('on cmp_1');
    expect(made).toHaveLength(1);
  });

  it('refuse a call with no id once computers exist, without naming them, and create nothing', async () => {
    const { made, shell } = await connect('claude-ai');
    await shell('new');
    await shell('new');
    const r = await shell();
    expect(r.isError).toBe(true);
    // Listing them would show one chat the other chats' ids.
    expect(r.text).not.toContain('cmp_1');
    expect(r.text).not.toContain('cmp_2');
    expect(made).toHaveLength(2);
  });

  it('refuse an id this process does not own, and create nothing', async () => {
    const { made, shell } = await connect('claude-ai');
    const r = await shell('cmp_from_another_chat');
    expect(r.isError).toBe(true);
    expect(made).toHaveLength(0);
  });

  it('ask for the computer id on every computer tool', async () => {
    const { client } = await connect('claude-ai');
    const { tools } = await client.listTools();
    const shell = tools.find((t) => t.name === 'shell');
    expect(Object.keys(shell?.inputSchema.properties ?? {})).toContain('computer');
  });
});

describe('a chat that never uses Husk', () => {
  it('creates nothing by connecting and listing', async () => {
    const { made, client } = await connect('claude-ai');
    await client.listTools();
    await client.listPrompts();
    expect(made).toHaveLength(0);
  });
});

describe('a host that names its session', () => {
  it('uses one computer per process and needs no id from the model', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-123';
    const { made, client, shell } = await connect('claude-code');
    const { tools } = await client.listTools();
    expect(Object.keys(tools.find((t) => t.name === 'shell')?.inputSchema.properties ?? {})).not.toContain('computer');
    const first = await shell();
    expect(first.text).not.toContain('Your computer id is');
    await shell('new');
    expect(made).toHaveLength(1);
    expect(made[0]?.info.spec.labels?.['husk.identity']).toBe('session');
    expect(made[0]?.info.spec.labels?.['husk.chat']).toMatch(/^Claude Code · session started \d\d:\d\d$/);
  });
});
