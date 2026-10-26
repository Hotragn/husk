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
import type { DaemonClient } from './daemon.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/**
 * A manager whose computers and bindings outlive any one server, the way
 * ~/.husk does, so two servers in a row stand in for an app restart.
 */
function fakeManager() {
  const made: Computer[] = [];
  const bindings = new Map<string, string>();
  const activity = { starts: 0, stops: 0, stopMs: 0 };
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
        if (info.state !== 'running') throw new Error(`computer ${id} is ${info.state}`);
        return { exitCode: 0, stdout: `on ${id}`, stderr: '', durationMs: 1, truncated: false, timedOut: false };
      },
      async refresh() {
        return info;
      },
      async start() {
        activity.starts++;
        info.state = 'running';
      },
      async stop() {
        activity.stops++;
        // Like `docker stop`: it takes a while, and inspect says running until it is done.
        await new Promise((r) => setTimeout(r, activity.stopMs));
        info.state = 'stopped';
      },
      async destroy() {
        info.state = 'destroyed';
      },
    } as unknown as Computer;
    made.push(c);
    return c;
  };
  const manager = {
    create: make,
    async ensure(key: string, spec: ComputerSpec) {
      const c = await make({ ...spec, labels: { ...(spec.labels ?? {}), 'husk.key': key } });
      bindings.set(key, c.id);
      return c;
    },
    async keyFor(id: string) {
      for (const [k, v] of bindings) if (v === id) return k;
      return undefined;
    },
    async get(id: string) {
      return made.find((c) => c.id === id) ?? null;
    },
  } as unknown as ComputerManager;
  return { made, bindings, activity, manager };
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

type Fake = ReturnType<typeof fakeManager>;
const servers: HuskMcpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((x) => x.close()));
});

async function connect(clientName: string, opts: { fake?: Fake; idleStopMs?: number; ephemeral?: boolean; shared?: DaemonClient } = {}) {
  const fake = opts.fake ?? fakeManager();
  const server = new HuskMcpServer({
    manager: fake.manager,
    ephemeral: opts.ephemeral ?? false,
    logger: silent,
    ...(opts.idleStopMs ? { idleStopMs: opts.idleStopMs } : {}),
    ...(opts.shared ? { shared: opts.shared } : {}),
  });
  servers.push(server);
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
  return { made: fake.made, fake, client, shell, server };
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

  it('gives a bot that continues a chat the chat’s own computer, whatever session the bot’s CLI is in', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'the-bots-own-run';
    process.env.HUSK_CHAT_SESSION = 'the-chat-it-continues';
    try {
      const { fake, made, shell } = await connect('claude-code');
      await shell();
      expect(made[0]?.info.spec.labels?.['husk.session']).toBe('the-chat-it-continues');
      expect([...fake.bindings.keys()]).toEqual(['claude-code:the-chat-it-continues']);
    } finally {
      delete process.env.HUSK_CHAT_SESSION;
    }
  });
});

describe('a chat computer outlives the process', () => {
  it('wakes after an app restart, by the id the chat carries, with its files', async () => {
    const fake = fakeManager();
    const before = await connect('claude-ai', { fake, ephemeral: true });
    const id = idIn((await before.shell('new')).text);
    await before.server.close();
    expect(fake.made[0]?.info.state).toBe('stopped');

    // A new process, as after a restart: it has never seen this id.
    const after = await connect('claude-ai', { fake });
    const r = await after.shell(id);
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`on ${id}`);
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]?.info.state).toBe('running');
  });

  it('stops when idle, and starts again when the chat calls', async () => {
    const fake = fakeManager();
    const { shell } = await connect('claude-ai', { fake, idleStopMs: 30 });
    const id = idIn((await shell('new')).text);
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.made[0]?.info.state).toBe('stopped');
    expect(fake.activity.stops).toBe(1);
    expect((await shell(id)).text).toContain(`on ${id}`);
    expect(fake.activity.starts).toBe(1);
  });

  it('never destroys a chat computer on disconnect', async () => {
    const fake = fakeManager();
    const { shell, server } = await connect('claude-ai', { fake, ephemeral: true });
    await shell('new');
    await server.close();
    expect(fake.made[0]?.info.state).toBe('stopped');
  });

  it('refuses a guessed id, and an id bound to something other than a chat', async () => {
    const fake = fakeManager();
    // A named session's computer exists, under its own key.
    await fake.manager.ensure('husk:qa-run', {});
    const { shell } = await connect('claude-ai', { fake });
    const named = await shell('cmp_1');
    expect(named.isError).toBe(true);
    const guessed = await shell('cmp_2');
    expect(guessed.isError).toBe(true);
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]?.info.state).toBe('running');
  });
});

describe('a call that arrives while the computer is being stopped for idleness', () => {
  it('waits for the stop, starts it again, and runs', async () => {
    const fake = fakeManager();
    fake.activity.stopMs = 80;
    const { shell } = await connect('claude-ai', { fake, idleStopMs: 20 });
    const id = idIn((await shell('new')).text);
    await new Promise((r) => setTimeout(r, 50)); // the idle stop has begun, not finished
    expect(fake.activity.stops).toBe(1);
    const r = await shell(id);
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`on ${id}`);
    expect(fake.activity.starts).toBe(1);
  });
});

describe('hand_off from a chat with no computer yet', () => {
  it('treats computer "new" as none, and creates nothing', async () => {
    const fake = fakeManager();
    const { client } = await connect('claude-ai', { fake });
    const r = (await client.callTool({ name: 'hand_off', arguments: { reason: 'Approve it on your phone.', computer: 'new' } })) as {
      isError?: boolean;
    };
    expect(r.isError).not.toBe(true);
    expect(fake.made).toHaveLength(0);
  });
});

describe('a chat computer the shared Husk serves', () => {
  const stopsAsked: string[] = [];
  const shared = (): DaemonClient => ({
    url: 'http://127.0.0.1:7377',
    async callTool(_id, name) {
      return { content: [{ type: 'text', text: `ran ${name} in the shared husk` }] };
    },
    async openHandoff() {
      throw new Error('not in these tests');
    },
    async state() {
      return 'unknown';
    },
    async complete() {},
    async cancel() {},
    async linkToken() {
      return 'token';
    },
    async markInChat() {},
    async stop(id) {
      stopsAsked.push(id);
    },
  });

  it('is never stopped by the chat when idle: the shared Husk owns it, and sees a person holding it', async () => {
    const fake = fakeManager();
    const { shell } = await connect('claude-ai', { fake, idleStopMs: 30, shared: shared() });
    expect((await shell('new')).text).toContain('ran shell in the shared husk');
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.activity.stops).toBe(0);
  });

  it('is stopped by the shared Husk when the chat closes, which refuses while a person holds it', async () => {
    stopsAsked.length = 0;
    const fake = fakeManager();
    const { shell, server } = await connect('claude-ai', { fake, ephemeral: true, shared: shared() });
    await shell('new');
    await server.close();
    expect(fake.made[0]?.info.state).toBe('running');
    expect(stopsAsked).toEqual(['cmp_1']);
  });
});
