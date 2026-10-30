import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@husk-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagerLike } from './deps.js';
import { UNREADABLE_HOLDS } from './handoffs.js';
import { takeover } from './routes/tools.js';
import { serve } from './serve.js';
import { FakeManager, FakeRouter, buildTestApp, fakeAgentFactory, fakeModelProvider } from './testing.js';
import type { TestApp } from './testing.js';

/**
 * Only the person ends their hold: not a restart of the shared Husk, not the
 * chat that asked, not the model's link. A sign-in handoff the chat asked for
 * still ends with the chat's hand_off_done, as before.
 */

const PERSON = { 'x-husk-as': 'person' };
const ran: string[] = [];
let dir = '';
let file = '';
const apps: TestApp[] = [];

beforeEach(() => {
  ran.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'husk-holds-'));
  file = join(dir, 'holds.json');
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.cleanup().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** The shared Husk, keeping its holds in `file`; `manager` to start again over the same computers. */
async function start(opts: { manager?: ManagerLike; token?: string } = {}): Promise<TestApp> {
  const h = await buildTestApp({
    holdsFile: file,
    ...opts,
    runTool: async (_c, name) => {
      ran.push(name);
      return { content: [{ type: 'text', text: 'ran' }] };
    },
  });
  apps.push(h);
  return h;
}

/** Stop it the way a restart does. */
async function stop(h: TestApp): Promise<void> {
  apps.splice(apps.indexOf(h), 1);
  await h.cleanup();
}

async function computer(h: TestApp, headers: Record<string, string> = {}): Promise<string> {
  return ((await h.app.inject({ method: 'POST', url: '/v1/computers', headers, payload: {} })).json() as { id: string }).id;
}

const done = (h: TestApp, handoffId: string, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done`, headers });

describe('a hold across a restart of the shared Husk', { timeout: 30_000 }, () => {
  it('keeps a take-over: the AI is still refused, until the person gives it back', async () => {
    const first = await start();
    const id = await computer(first);
    const { handoffId } = (await first.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover`, headers: PERSON })).json() as { handoffId: string };
    await stop(first);

    const second = await start({ manager: first.manager });
    expect((await second.app.inject({ method: 'GET', url: '/v1/overview' })).json().handoffs).toEqual([
      expect.objectContaining({ handoffId, computerId: id, runId: 'person', takenFrom: 'console' }),
    ]);
    const before = takeover.waitMs;
    takeover.waitMs = 200;
    try {
      const res = (await second.app.inject({ method: 'POST', url: `/v1/computers/${id}/tools/shell`, payload: { args: {} } })).json();
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('took over this computer');
    } finally {
      takeover.waitMs = before;
    }
    expect(ran).toEqual([]);

    expect((await done(second, handoffId, PERSON)).statusCode).toBe(200);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('keeps a chat’s handoff, which the chat’s hand_off_done still ends', async () => {
    const first = await start();
    const id = await computer(first);
    const { handoffId } = (await first.app.inject({ method: 'POST', url: `/v1/computers/${id}/handoffs`, payload: { reason: 'Sign in to GitHub' } })).json() as { handoffId: string };
    await stop(first);

    const second = await start({ manager: first.manager });
    const state = async () => (await second.app.inject({ method: 'GET', url: `/v1/handoffs/${handoffId}/state` })).json().state;
    expect(await state()).toBe('open');
    // As the chat's hand_off_done sends it: the server token, no person.
    expect((await done(second, handoffId)).statusCode).toBe(200);
    expect(await state()).toBe('done');
  });

  it('is still held after a clean stop of the real server, as Ctrl-C or SIGTERM stop it', async () => {
    vi.stubEnv('HUSK_HOME', dir);
    try {
      const deps = { manager: new FakeManager(), router: new FakeRouter(), modelProviders: [fakeModelProvider], agentFactory: fakeAgentFactory() };
      const server = await serve({ port: 0, daemon: true, reaperIntervalMs: 0, logger: createLogger({ level: 'silent' }), deps });
      const id = ((await server.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string }).id;
      expect((await server.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover`, headers: PERSON })).json()).toHaveProperty('handoffId');
      await server.close();
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([expect.objectContaining({ computerId: id, runId: 'person' })]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed when the holds cannot be read: every computer is held for the person', async () => {
    const first = await start();
    const ids = [await computer(first), await computer(first)];
    await stop(first);
    writeFileSync(file, '{ not json');

    const second = await start({ manager: first.manager });
    const holds = (await second.app.inject({ method: 'GET', url: '/v1/overview' })).json().handoffs as Array<{ computerId: string; runId: string; reason: string }>;
    expect(holds.map((h) => h.computerId).sort()).toEqual([...ids].sort());
    expect(holds.every((h) => h.runId === 'person' && h.reason === UNREADABLE_HOLDS)).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith('holds.json.unreadable-'))).toBe(true);
  });
});

describe('who ends a person’s take-over', { timeout: 30_000 }, () => {
  // The server token, as a chat's MCP process has it; the console adds that it is the person.
  const master = { authorization: 'Bearer server-token' };
  const asPerson = { ...master, ...PERSON };

  async function linked() {
    const h = await start({ token: 'server-token' });
    const id = await computer(h, master);
    const { token } = (await h.app.inject({ method: 'POST', url: `/v1/computers/${id}/link`, headers: master })).json() as { token: string };
    return { h, id, link: { authorization: `Bearer ${token}` } };
  }

  it('only the person: not a program, not the model’s link, not the chat going away', async () => {
    const { h, id, link } = await linked();
    const { handoffId } = (await h.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover`, headers: asPerson })).json() as { handoffId: string };

    const refused = await done(h, handoffId, master);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('E_COMPUTER_HELD');
    expect((await done(h, handoffId, link)).statusCode).toBe(409);
    expect((await h.app.inject({ method: 'DELETE', url: `/v1/handoffs/${handoffId}`, headers: master })).statusCode).toBe(409);

    expect((await done(h, handoffId, asPerson)).statusCode).toBe(200);
  });

  it('a take-over made from a link can be given back from that link', async () => {
    const { h, link } = await linked();
    const taken = (await h.app.inject({ method: 'POST', url: '/v1/scoped/computer/takeover', headers: link })).json() as { handoffId: string; takenFrom: string };
    expect(taken.takenFrom).toBe('link');
    expect((await done(h, taken.handoffId, link)).statusCode).toBe(200);
  });

  it('taking the handoff a chat asked for makes it the person’s, which the chat’s done no longer ends', async () => {
    const { h, id } = await linked();
    const { handoffId } = (await h.app.inject({ method: 'POST', url: `/v1/computers/${id}/handoffs`, headers: master, payload: { reason: 'Sign in' } })).json() as { handoffId: string };
    const taken = await h.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover`, headers: asPerson });
    expect(taken.statusCode).toBe(200);
    expect(taken.json()).toMatchObject({ handoffId, runId: 'person', takenFrom: 'console' });

    expect((await done(h, handoffId, master)).statusCode).toBe(409);
    expect((await done(h, handoffId, asPerson)).statusCode).toBe(200);
    // The chat polling it hears done, and goes on.
    expect((await h.app.inject({ method: 'GET', url: `/v1/handoffs/${handoffId}/state`, headers: master })).json().state).toBe('done');
  });
});
