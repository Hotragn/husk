/**
 * The in-chat computer card (MCP Apps) and its plain-link fallback.
 *
 * Covers what the brief asks of it: the card appears only for clients that
 * render MCP Apps, its tools never reach a model that cannot see cards, its
 * links carry a short-lived token scoped to one computer, and a link for one
 * chat's computer cannot open another chat's.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Computer, ComputerSpec, Logger } from '@husk-ai/core';
import type { ComputerManager } from '@husk-ai/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARD_MIME, CARD_URI } from './card.js';
import { HuskMcpServer } from './server.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function fakeManager() {
  const made: Computer[] = [];
  const bindings = new Map<string, string>();
  const make = async (spec: ComputerSpec) => {
    const id = `cmp_${made.length + 1}`;
    const info = { id, name: id, provider: 'docker', state: 'running', image: 'x', workdir: '/work', createdAt: '', lastUsedAt: '', spec };
    const c = {
      id,
      info,
      async exec() {
        return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, truncated: false, timedOut: false };
      },
      async refresh() {
        return info;
      },
      async start() {},
      async stop() {},
      async destroy() {},
    } as unknown as Computer;
    made.push(c);
    return c;
  };
  return {
    made,
    manager: {
      create: make,
      async ensure(key: string, spec: ComputerSpec) {
        const c = await make(spec);
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
    } as unknown as ComputerManager,
  };
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});
const servers: HuskMcpServer[] = [];
afterEach(async () => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = saved;
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function connect(rendersCards: boolean) {
  const { manager, made } = fakeManager();
  const server = new HuskMcpServer({ manager, ephemeral: false, logger: silent });
  servers.push(server);
  const capabilities = rendersCards ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [CARD_MIME] } } } : {};
  const client = new Client({ name: 'claude-ai', version: '1' }, { capabilities: capabilities as never });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(s), client.connect(c)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: Record<string, unknown>;
    };
  return { client, call, made };
}

const tokenIn = (url: string) => /token=([0-9a-f]+)/.exec(url)?.[1] ?? '';
const originIn = (url: string) => /^(http:\/\/127\.0\.0\.1:\d+)/.exec(url)?.[1] ?? '';

describe('the computer card', () => {
  it('is offered to a client that renders MCP Apps: card on computer_info and hand_off, plus app-only tools', async () => {
    const { client } = await connect(true);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('computer_info')?._meta).toEqual({ ui: { resourceUri: CARD_URI } });
    expect(byName.get('hand_off')?._meta).toEqual({ ui: { resourceUri: CARD_URI } });
    expect(byName.get('computer_card_state')?._meta).toMatchObject({ ui: { visibility: ['app'] } });
    expect(byName.get('computer_card_link')?._meta).toMatchObject({ ui: { visibility: ['app'] } });

    const read = await client.readResource({ uri: CARD_URI });
    expect(read.contents[0]).toMatchObject({ uri: CARD_URI, mimeType: CARD_MIME });
    const html = (read.contents[0] as { text: string }).text;
    // No network of its own: no fetch, no XHR, no WebSocket; text set as text.
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|innerHTML/);
  });

  it('is never shown to a client that cannot render it, which gets the plain link tool instead', async () => {
    const { client } = await connect(false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('computer_card_state');
    expect(names).not.toContain('computer_card_link');
    expect(names).toContain('computer_open_ui');
    expect((await client.listTools()).tools.find((t) => t.name === 'computer_info')?._meta).toBeUndefined();
  });

  it('gives the card state without a token, and a link only when asked', async () => {
    const { call } = await connect(true);
    const info = await call('computer_info', { computer: 'new' });
    expect(info.structuredContent).toMatchObject({ computerId: 'cmp_1', state: 'running' });
    expect(JSON.stringify(info.structuredContent)).not.toMatch(/token/);

    const link = await call('computer_card_link', { computer: 'cmp_1' });
    expect(String(link.structuredContent?.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#computer=cmp_1&token=[0-9a-f]{64}$/);
  });

  it('switches to waiting when a handoff holds the computer', async () => {
    const { call } = await connect(true);
    await call('computer_info', { computer: 'new' });
    const handed = await call('hand_off', { reason: 'Sign in to example.com.', computer: 'cmp_1' });
    expect(handed.structuredContent).toMatchObject({ computerId: 'cmp_1', waiting: { reason: 'Sign in to example.com.' } });
    const state = await call('computer_card_state', { computer: 'cmp_1' });
    expect(state.structuredContent).toMatchObject({ waiting: { reason: 'Sign in to example.com.' } });
    expect(String((await call('computer_card_link', { computer: 'cmp_1' })).structuredContent?.url)).toContain('#handoff=');
  });

  it('refuses an id that is not this chat app\'s, and creates nothing', async () => {
    const { call, made } = await connect(true);
    expect((await call('computer_card_state', { computer: 'cmp_nope' })).isError).toBe(true);
    expect((await call('computer_card_link', { computer: 'cmp_nope' })).isError).toBe(true);
    expect(made).toHaveLength(0);
  });
});

describe('a card link opens one computer and nothing else', () => {
  it('scopes the token to its computer: chat A\'s link cannot open chat B\'s computer or handoff', async () => {
    const { call } = await connect(true);
    await call('computer_info', { computer: 'new' });
    await call('computer_info', { computer: 'new' });
    await call('hand_off', { reason: 'Sign in.', computer: 'cmp_2' });

    const a = String((await call('computer_card_link', { computer: 'cmp_1' })).structuredContent?.url);
    const origin = originIn(a);
    const get = (path: string, token: string) => fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });

    const asA = await get('/v1/scoped/computer', tokenIn(a));
    expect(asA.status).toBe(200);
    expect(((await asA.json()) as { computerId: string }).computerId).toBe('cmp_1');

    // B's handoff, with A's token.
    const bState = (await call('computer_card_state', { computer: 'cmp_2' })).structuredContent as { waiting: { handoffId: string } };
    expect((await get(`/v1/handoffs/${bState.waiting.handoffId}`, tokenIn(a))).status).toBe(404);
    // B's own link does open it.
    const b = String((await call('computer_card_link', { computer: 'cmp_2' })).structuredContent?.url);
    expect((await get(`/v1/handoffs/${bState.waiting.handoffId}`, tokenIn(b))).status).toBe(200);
  });

  it('is not the viewer token, and the viewer token does not open a computer', async () => {
    const { call } = await connect(true);
    await call('computer_info', { computer: 'new' });
    const viewer = (await call('workspace_open_ui')).content.map((c) => c.text).join('\n');
    const viewerToken = /#token=([0-9a-f]+)/.exec(viewer)?.[1] ?? '';
    const a = String((await call('computer_card_link', { computer: 'cmp_1' })).structuredContent?.url);
    const origin = originIn(a);
    expect((await fetch(`${origin}/v1/scoped/computer`, { headers: { authorization: `Bearer ${viewerToken}` } })).status).toBe(404);
    // And a computer token does not open the workspace API.
    expect((await fetch(`${origin}/v1/workspaces`, { headers: { authorization: `Bearer ${tokenIn(a)}` } })).status).toBe(401);
  });

  it('does not create a computer just to show one', async () => {
    const { call, made } = await connect(false);
    const r = await call('computer_open_ui', { computer: 'new' });
    expect(r.isError).toBe(true);
    expect(made).toHaveLength(0);
  });

  it('puts a working link in the first computer call for a client without cards, and Take over works from it', async () => {
    const { call } = await connect(false);
    const first = (await call('shell', { command: 'echo', computer: 'new' })).content[0]!.text;
    const url = /take it over at (http:\/\/127\.0\.0\.1:\d+\/#computer=cmp_1&token=[0-9a-f]{64}) /.exec(first)?.[1] ?? '';
    expect(url).not.toBe('');
    expect((await call('shell', { command: 'echo', computer: 'cmp_1' })).content[0]!.text).not.toMatch(/token=/);

    const taken = await fetch(`${originIn(url)}/v1/scoped/computer/takeover`, { method: 'POST', headers: { authorization: `Bearer ${tokenIn(url)}` } });
    expect(taken.status).toBe(201);
    const { handoffId } = (await taken.json()) as { handoffId: string };
    // The chat is paused, and cannot give itself the computer back.
    const held = await call('shell', { command: 'echo', computer: 'cmp_1' });
    expect(held.isError).toBe(true);
    expect(held.content[0]!.text).toContain('took over this computer');
    expect(held.content[0]!.text).toContain('computer_open_ui');
    expect((await call('hand_off_done', { handoff: handoffId })).isError).toBe(true);
    // Asking for the person again gets the same words, never "call hand_off_done".
    const handOff = await call('hand_off', { reason: 'Sign in', computer: 'cmp_1' });
    expect(handOff.isError).toBe(true);
    expect(handOff.content[0]!.text).toContain('took over this computer');
    expect(handOff.content[0]!.text).not.toContain('then call hand_off_done');
    // Give back with the same link, which still opens the computer afterwards.
    const auth = { authorization: `Bearer ${tokenIn(url)}` };
    expect((await fetch(`${originIn(url)}/v1/handoffs/${handoffId}/done`, { method: 'POST', headers: auth })).status).toBe(200);
    expect((await fetch(`${originIn(url)}/v1/scoped/computer`, { headers: auth })).status).toBe(200);
    expect((await call('shell', { command: 'echo', computer: 'cmp_1' })).isError).toBeFalsy();
  });

  it('leaves the link out of the first call for a client that shows the card', async () => {
    const { call } = await connect(true);
    expect(JSON.stringify((await call('shell', { command: 'echo', computer: 'new' })).content)).not.toMatch(/token=/);
  });

  it('gives a plain link for a client without cards', async () => {
    const { call } = await connect(false);
    await call('shell', { command: 'echo', computer: 'new' });
    const r = await call('computer_open_ui', { computer: 'cmp_1' });
    expect(r.content[0]?.text).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#computer=cmp_1&token=[0-9a-f]{64}/);
  });
});
