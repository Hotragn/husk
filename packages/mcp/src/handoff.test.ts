/**
 * hand_off over MCP: the chat's own model hands the computer to the person.
 *
 * The rules match the agent-side tool: only the person ends a handoff (in-chat
 * prompt, the viewer's Done, or their word relayed by hand_off_done), nothing
 * resumes on a timeout or an error, the reason is redacted model text, and a
 * handoff link opens that one handoff and nothing else.
 */
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { Computer, Logger } from '@husk-ai/core';
import type { ComputerManager } from '@husk-ai/runtime';
import { WorkspaceStore } from '@husk-ai/workspaces';
import { afterEach, describe, expect, it } from 'vitest';
import { HuskMcpServer } from './server.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

const computer = {
  id: 'cmp_fake',
  info: {
    id: 'cmp_fake',
    name: 'fake',
    provider: 'docker',
    state: 'running',
    image: 'x',
    workdir: '/work',
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    spec: { provider: 'docker' },
  },
  async exec() {
    return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, truncated: false, timedOut: false };
  },
  async destroy() {},
  async refresh() {
    return computer.info;
  },
} as unknown as Computer;

const open: HuskMcpServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

type Elicit = (message: string) => Promise<ElicitResult>;

async function session(elicit?: Elicit, clientName = 'claude-code') {
  const manager = { async ensure() { return computer; }, async create() { return computer; } } as unknown as ComputerManager;
  const workspaceStore = new WorkspaceStore({ root: mkdtempSync(join(tmpdir(), 'husk-handoff-')) });
  const server = new HuskMcpServer({ manager, ephemeral: false, logger: silent, workspaceStore });
  open.push(server);
  const client = new Client({ name: clientName, version: '0' }, { capabilities: elicit ? { elicitation: {} } : {} });
  const asked: string[] = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const message = String((req.params as { message?: string }).message);
      asked.push(message);
      return elicit(message);
    });
  }
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(s), client.connect(c)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: r.isError === true, text: r.content.map((x) => x.text).join('\n') };
  };
  return { call, asked };
}

const linkIn = (text: string) => {
  const m = /(http:\/\/127\.0\.0\.1:\d+)\/#handoff=([^&\s]+)&token=([0-9a-f]+)/.exec(text);
  if (!m) throw new Error(`no handoff link in: ${text}`);
  return { origin: m[1]!, handoffId: decodeURIComponent(m[2]!), key: m[3]! };
};

describe('hand_off over MCP, without in-chat prompts', () => {
  it('returns a link to relay and holds the computer until the person is done', async () => {
    const { call } = await session();
    const r = await call('hand_off', { reason: 'Sign in to example.com.' });
    expect(r.isError).toBe(false);
    const { handoffId } = linkIn(r.text);
    expect(r.text).toContain('Sign in to example.com.');

    const held = await call('shell', { command: 'echo hi' });
    expect(held.isError).toBe(true);
    expect(held.text).toContain(handoffId);
    expect((await call('browser_click', { ref: 'e1' })).isError).toBe(true);

    expect((await call('hand_off_done', { handoff: handoffId })).isError).toBe(false);
    expect((await call('shell', { command: 'echo hi' })).isError).toBe(false);
  });

  it('refuses a second handoff while one is open, and an unknown id', async () => {
    const { call } = await session();
    await call('hand_off', { reason: 'Approve the prompt.' });
    expect((await call('hand_off', { reason: 'Again.' })).isError).toBe(true);
    expect((await call('hand_off_done', { handoff: 'hnd_nope' })).isError).toBe(true);
  });

  it('refuses an empty or overlong reason, and redacts secrets in it', async () => {
    const { call } = await session();
    expect((await call('hand_off', { reason: '  ' })).isError).toBe(true);
    expect((await call('hand_off', { reason: 'x'.repeat(501) })).isError).toBe(true);
    const key = 'sk-ant-api03-' + 'a'.repeat(40);
    const r = await call('hand_off', { reason: `Paste ${key} into the form.` });
    expect(r.text).not.toContain(key);
    const { origin, handoffId, key: k } = linkIn(r.text);
    const body = (await (await fetch(`${origin}/v1/handoffs/${handoffId}`, { headers: { authorization: `Bearer ${k}` } })).json()) as { reason: string };
    expect(body.reason).not.toContain(key);
  });
});

describe('hand_off over MCP, with in-chat prompts', () => {
  it('gives the link at once to a client that declares prompts but is not known to show them', async () => {
    let asked = false;
    const { call } = await session(async () => {
      asked = true;
      return new Promise<ElicitResult>(() => {});
    }, 'claude-ai');
    const r = await call('hand_off', { reason: 'Sign in.' });
    expect(asked).toBe(false);
    linkIn(r.text);
    expect((await call('shell', { command: 'echo hi' })).isError).toBe(true);
  });

  it('resumes when the person answers done, without giving the model the link', async () => {
    const { call, asked } = await session(async () => ({ action: 'accept', content: { done: true } }));
    const r = await call('hand_off', { reason: 'Enter the 2FA code.' });
    expect(r.isError).toBe(false);
    expect(r.text).not.toMatch(/token=/);
    expect(asked[0]).toContain('Enter the 2FA code.');
    expect(asked[0]).toMatch(/#handoff=/);
    expect((await call('shell', { command: 'echo hi' })).isError).toBe(false);
  });

  for (const [label, elicit] of [
    ['declines', async () => ({ action: 'decline' })],
    ['cancels', async () => ({ action: 'cancel' })],
    ['answers not done', async () => ({ action: 'accept', content: { done: false } })],
    ['the prompt fails or times out', async () => { throw new Error('Request timed out'); }],
  ] as Array<[string, Elicit]>) {
    it(`stays paused when the person ${label}`, async () => {
      const { call } = await session(elicit);
      const r = await call('hand_off', { reason: 'Sign in.' });
      expect(r.isError).toBe(false);
      linkIn(r.text);
      expect((await call('shell', { command: 'echo hi' })).isError).toBe(true);
    });
  }

  it('resumes when the person presses Done in the viewer before answering', async () => {
    const { call } = await session(async (message) => {
      const { origin, handoffId, key } = linkIn(message);
      await fetch(`${origin}/v1/handoffs/${handoffId}/done`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
      // The prompt is never answered.
      return new Promise<ElicitResult>(() => {});
    });
    const r = await call('hand_off', { reason: 'Sign in.' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('they are done');
    expect((await call('shell', { command: 'echo hi' })).isError).toBe(false);
  });
});

describe('the handoff link opens one handoff and nothing else', () => {
  it('scopes every route to its own key', async () => {
    const { call } = await session();
    const viewer = await call('workspace_open_ui');
    const viewerToken = /#token=([0-9a-f]+)/.exec(viewer.text)?.[1] ?? '';
    expect(viewerToken).not.toBe('');

    const r = await call('hand_off', { reason: 'Sign in.' });
    const { origin, handoffId, key } = linkIn(r.text);
    const get = (path: string, token: string, init: RequestInit = {}) =>
      fetch(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}` } });

    expect((await get(`/v1/handoffs/${handoffId}`, key)).status).toBe(200);
    expect((await get(`/v1/handoffs/${handoffId}`, 'f'.repeat(64))).status).toBe(404);
    // The viewer's own token does not open a handoff.
    expect((await get(`/v1/handoffs/${handoffId}`, viewerToken)).status).toBe(404);
    // A handoff key does not open the workspace API, or list handoffs.
    expect((await get('/v1/workspaces', key)).status).toBe(401);
    expect((await get('/v1/handoffs', key)).status).toBe(401);
    // Input is a closed schema.
    const bad = await get(`/v1/handoffs/${handoffId}/input`, key, {
      method: 'POST',
      body: JSON.stringify({ type: 'eval', code: 'alert(1)' }),
    });
    expect(bad.status).toBe(422);
    // Another host name is refused before anything else (DNS rebinding).
    // fetch drops a custom Host header, so this one goes through node:http.
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request(`${origin}/v1/handoffs/${handoffId}`, {
        headers: { authorization: `Bearer ${key}`, host: 'evil.example' },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(rebound).toBe(403);

    expect((await get(`/v1/handoffs/${handoffId}/done`, key, { method: 'POST' })).status).toBe(200);
    // The key dies with the handoff.
    expect((await get(`/v1/handoffs/${handoffId}`, key)).status).toBe(404);
    expect((await call('hand_off_done', { handoff: handoffId })).isError).toBe(false);
    expect((await call('shell', { command: 'echo hi' })).isError).toBe(false);
  });
});
