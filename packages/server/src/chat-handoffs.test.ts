import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeover } from './routes/tools.js';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';
import { HandoffRegistry, PERSON_RUN, ScopedTokens, createWorkspaceViewer } from './workspace-viewer.js';

let harness: TestApp;
afterEach(async () => {
  await harness?.cleanup();
});

const master = { authorization: 'Bearer server-token' };

async function setup() {
  harness = await buildTestApp({ token: 'server-token' });
  const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', headers: master, payload: {} })).json() as { id: string };
  const opened = await harness.app.inject({
    method: 'POST',
    url: `/v1/computers/${id}/handoffs`,
    headers: master,
    payload: { reason: 'Sign in to GitHub' },
  });
  expect(opened.statusCode).toBe(201);
  const body = opened.json() as { handoffId: string; token: string; computerId: string };
  return { id, ...body, link: { authorization: `Bearer ${body.token}` } };
}

describe('a chat handoff on the control plane', { timeout: 30_000 }, () => {
  it('opens one the overview lists, with a link token for that computer', async () => {
    const { id, handoffId } = await setup();
    const overview = (await harness.app.inject({ method: 'GET', url: '/v1/overview', headers: master })).json();
    expect(overview.handoffs).toEqual([expect.objectContaining({ handoffId, computerId: id, reason: 'Sign in to GitHub' })]);
  });

  it('lets the link token see that computer and finish that handoff, and nothing else', async () => {
    const { id, handoffId, link } = await setup();
    expect((await harness.app.inject({ method: 'GET', url: '/v1/scoped/computer', headers: link })).json()).toMatchObject({
      computerId: id,
      // Where it runs: on ssh and fly the link's view shows the screen only when asked.
      provider: expect.any(String),
      handoff: { handoffId },
    });
    expect((await harness.app.inject({ method: 'GET', url: `/v1/handoffs/${handoffId}`, headers: link })).statusCode).toBe(200);
    // Not the list, not the computers, not the token's own minting route.
    for (const url of ['/v1/handoffs', '/v1/computers', `/v1/computers/${id}`, '/v1/overview']) {
      expect((await harness.app.inject({ method: 'GET', url, headers: link })).statusCode).toBe(401);
    }
    expect((await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/link`, headers: link })).statusCode).toBe(401);
    expect((await harness.app.inject({ method: 'DELETE', url: `/v1/handoffs/${handoffId}`, headers: link })).statusCode).toBe(404);

    const done = await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done`, headers: link });
    expect(done.json()).toEqual({ handoffId, outcome: 'done' });
    expect((await harness.app.inject({ method: 'GET', url: `/v1/handoffs/${handoffId}`, headers: master })).statusCode).toBe(404);
  });

  it('does not let a link for one computer open another computer’s handoff', async () => {
    const first = await setup();
    const { id: other } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', headers: master, payload: {} })).json() as { id: string };
    const second = (
      await harness.app.inject({ method: 'POST', url: `/v1/computers/${other}/handoffs`, headers: master, payload: { reason: 'x' } })
    ).json() as { handoffId: string };
    const res = await harness.app.inject({ method: 'GET', url: `/v1/handoffs/${second.handoffId}`, headers: first.link });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a second handoff on the same computer, and cancels on request', async () => {
    const { id, handoffId } = await setup();
    const again = await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/handoffs`, headers: master, payload: { reason: 'y' } });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    const cancelled = await harness.app.inject({ method: 'DELETE', url: `/v1/handoffs/${handoffId}`, headers: master });
    expect(cancelled.statusCode).toBe(200);
    expect((await harness.app.inject({ method: 'GET', url: '/v1/handoffs', headers: master })).json().handoffs).toEqual([]);
  });
});

describe('the chat tool route', { timeout: 30_000 }, () => {
  it('says so when the server has no chat tools', async () => {
    harness = await buildTestApp();
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    const res = await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/tools/shell`, payload: { args: {} } });
    expect(res.statusCode).toBe(501);
  });

  it('refuses every tool but computer_info while a person holds the computer', async () => {
    const ran: string[] = [];
    harness = await buildTestApp({
      runTool: async (_c, name) => {
        ran.push(name);
        return { content: [{ type: 'text', text: 'ran' }] };
      },
    });
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/handoffs`, payload: { reason: 'Sign in' } });

    const shell = (await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/tools/shell`, payload: { args: {} } })).json();
    expect(shell.isError).toBe(true);
    expect(shell.content[0].text).toContain('The user has the computer right now');
    const info = (await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/tools/computer_info`, payload: {} })).json();
    expect(info.isError).toBeUndefined();
    expect(ran).toEqual(['computer_info']);
  });
});

describe('a person taking a computer from the console', { timeout: 30_000 }, () => {
  const ran: string[] = [];
  async function taken() {
    ran.length = 0;
    harness = await buildTestApp({
      runTool: async (_c, name) => {
        ran.push(name);
        return { content: [{ type: 'text', text: 'ran' }] };
      },
    });
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    const res = await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover` });
    expect(res.statusCode).toBe(201);
    return { id, handoffId: (res.json() as { handoffId: string }).handoffId };
  }
  const shell = (id: string) => harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/tools/shell`, payload: { args: {} } });

  it('pauses a chat’s call until the person gives the computer back, then runs it', async () => {
    const { id, handoffId } = await taken();
    const call = shell(id);
    await new Promise((r) => setTimeout(r, 600));
    expect(ran).toEqual([]);
    await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done`, headers: { 'x-husk-as': 'person' } });
    expect((await call).json().content[0].text).toBe('ran');
  });

  it('tells the chat it is paused when the person keeps it, and offers it no done to call', async () => {
    const { id, handoffId } = await taken();
    const before = takeover.waitMs;
    takeover.waitMs = 300;
    try {
      const res = (await shell(id)).json();
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('took over this computer');
      expect(ran).toEqual([]);
    } finally {
      takeover.waitMs = before;
    }
    // Taking it again while held hands back the same one; it has no lease to run out.
    expect((await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover` })).json().handoffId).toBe(handoffId);
  });

  it("waits out the take-over for a bot's call, past a chat's wait, with nobody to tell (J5-e)", async () => {
    const { id, handoffId } = await taken();
    const before = takeover.waitMs;
    takeover.waitMs = 300;
    try {
      const call = harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/tools/shell`, payload: { args: {}, via: 'bot' } });
      await new Promise((r) => setTimeout(r, 900));
      expect(ran).toEqual([]);
      await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done`, headers: { 'x-husk-as': 'person' } });
      expect((await call).json().content[0].text).toBe('ran');
    } finally {
      takeover.waitMs = before;
    }
  });
});

describe('a chat handoff that ends', { timeout: 30_000 }, () => {
  it('reports how it ended, and its link stops working', async () => {
    const { handoffId, link } = await setup();
    expect((await harness.app.inject({ method: 'GET', url: `/v1/handoffs/${handoffId}/state`, headers: master })).json().state).toBe('open');
    await harness.app.inject({ method: 'DELETE', url: `/v1/handoffs/${handoffId}`, headers: master });
    expect((await harness.app.inject({ method: 'GET', url: `/v1/handoffs/${handoffId}/state`, headers: master })).json().state).toBe('aborted');
    expect((await harness.app.inject({ method: 'GET', url: '/v1/scoped/computer', headers: link })).statusCode).toBe(401);
  });

  it('keeps the state route for the server token only', async () => {
    const { handoffId, link } = await setup();
    expect((await harness.app.inject({ method: 'GET', url: `/v1/handoffs/${handoffId}/state`, headers: link })).statusCode).toBe(404);
  });
});

describe('a chat that stops polling its handoff', () => {
  it('has the handoff cancelled after a minute, never marked done', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    try {
      const { handoffId } = await setup();
      vi.advanceTimersByTime(30_000);
      expect((await harness.app.inject({ method: 'GET', url: `/v1/handoffs/${handoffId}/state`, headers: master })).json().state).toBe('open');
      vi.advanceTimersByTime(90_000);
      expect((await harness.app.inject({ method: 'GET', url: `/v1/handoffs/${handoffId}/state`, headers: master })).json().state).toBe('aborted');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /v1/shutdown', { timeout: 30_000 }, () => {
  it('needs the server token, and refuses while a person holds a computer', async () => {
    const { handoffId } = await setup();
    expect((await harness.app.inject({ method: 'POST', url: '/v1/shutdown' })).statusCode).toBe(401);
    // An embedded app has no way to stop its process.
    expect((await harness.app.inject({ method: 'POST', url: '/v1/shutdown', headers: master })).statusCode).toBe(501);
    harness.app.husk.shutdown = async () => {};
    expect((await harness.app.inject({ method: 'POST', url: '/v1/shutdown', headers: master })).statusCode).toBe(403);
    await harness.app.inject({ method: 'DELETE', url: `/v1/handoffs/${handoffId}`, headers: master });
    expect((await harness.app.inject({ method: 'POST', url: '/v1/shutdown', headers: master })).statusCode).toBe(202);
  });
});

describe('a computer link taking over', { timeout: 30_000 }, () => {
  async function linked() {
    harness = await buildTestApp({ token: 'server-token' });
    const make = async () => (await harness.app.inject({ method: 'POST', url: '/v1/computers', headers: master, payload: {} })).json().id as string;
    const id = await make();
    const other = await make();
    const { token } = (await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/link`, headers: master })).json() as { token: string };
    return { id, other, link: { authorization: `Bearer ${token}` } };
  }
  const takeOver = (headers: Record<string, string>) => harness.app.inject({ method: 'POST', url: '/v1/scoped/computer/takeover', headers });

  it('takes the link’s own computer as the person, and taking it again hands back the same one', async () => {
    const { id, link } = await linked();
    const first = await takeOver(link);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ runId: 'person', computerId: id });
    const again = await takeOver(link);
    expect(again.statusCode).toBe(200);
    expect(again.json().handoffId).toBe(first.json().handoffId);
    expect((await harness.app.inject({ method: 'GET', url: '/v1/scoped/computer', headers: link })).json().handoff.handoffId).toBe(first.json().handoffId);
  });

  it('touches no other computer, and the link still reaches nothing outside its scope', async () => {
    const { id, other, link } = await linked();
    await takeOver(link);
    const held = (await harness.app.inject({ method: 'GET', url: '/v1/handoffs', headers: master })).json().handoffs;
    expect(held.map((h: { computerId: string }) => h.computerId)).toEqual([id]);
    for (const url of [`/v1/computers/${id}/takeover`, `/v1/computers/${other}/takeover`, `/v1/computers/${id}/link`]) {
      expect((await harness.app.inject({ method: 'POST', url, headers: link })).statusCode).toBe(401);
    }
    expect((await harness.app.inject({ method: 'GET', url: '/v1/handoffs', headers: link })).statusCode).toBe(401);
    // Without a link there is nothing to take; with a wrong one, nothing either.
    expect((await takeOver({})).statusCode).toBe(401);
    expect((await takeOver({ authorization: 'Bearer nope' })).statusCode).toBe(401);
  });

  it('uses the handoff with the same link, and keeps the link working after Give back', async () => {
    const { link } = await linked();
    const { handoffId } = (await takeOver(link)).json() as { handoffId: string };
    // Authorized, and only then told there is no browser: the link reaches the input route.
    const typed = await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/input`, headers: link, payload: { type: 'text', text: 'x' } });
    expect(typed.json().error.code).toBe('E_BROWSER_NOT_FOUND');
    expect((await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done`, headers: link })).json()).toEqual({ handoffId, outcome: 'done' });
    const after = await harness.app.inject({ method: 'GET', url: '/v1/scoped/computer', headers: link });
    expect(after.statusCode).toBe(200);
    expect(after.json().handoff).toBeNull();
    expect((await takeOver(link)).statusCode).toBe(201);
  });

  it('pauses the chat while held from a link, as a take-over from the console does', async () => {
    const ran: string[] = [];
    harness = await buildTestApp({
      token: 'server-token',
      runTool: async (_c, name) => {
        ran.push(name);
        return { content: [{ type: 'text', text: 'ran' }] };
      },
    });
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', headers: master, payload: {} })).json() as { id: string };
    const { token } = (await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/link`, headers: master })).json() as { token: string };
    const { handoffId } = (await takeOver({ authorization: `Bearer ${token}` })).json() as { handoffId: string };
    const call = harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/tools/shell`, headers: master, payload: { args: {} } });
    await new Promise((r) => setTimeout(r, 600));
    expect(ran).toEqual([]);
    await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done`, headers: { authorization: `Bearer ${token}` } });
    expect((await call).json().content[0].text).toBe('ran');
  });
});

describe('a chat’s own viewer taking over', () => {
  it('opens a person’s handoff on the link’s computer only, and keeps the link after Give back', async () => {
    const registry = new HandoffRegistry();
    const tokens = new ScopedTokens();
    const root = await mkdtemp(join(tmpdir(), 'husk-viewer-take-'));
    const { app } = await createWorkspaceViewer({
      consoleDir: root,
      handoffs: { registry, tokens, describe: async (id) => (id === 'cmp_a' ? { computerId: id, state: 'running' } : undefined) },
    });
    try {
      const headers = { host: '127.0.0.1', authorization: `Bearer ${tokens.mint('computer:cmp_a')}` };
      const taken = await app.inject({ method: 'POST', url: '/v1/scoped/computer/takeover', headers });
      expect(taken.statusCode).toBe(201);
      expect(registry.list()).toEqual([expect.objectContaining({ runId: PERSON_RUN, computerId: 'cmp_a' })]);
      const gone = { ...headers, authorization: `Bearer ${tokens.mint('computer:cmp_gone')}` };
      expect((await app.inject({ method: 'POST', url: '/v1/scoped/computer/takeover', headers: gone })).statusCode).toBe(404);
      await app.inject({ method: 'POST', url: `/v1/handoffs/${taken.json().handoffId}/done`, headers });
      expect(registry.list()).toEqual([]);
      expect((await app.inject({ method: 'GET', url: '/v1/scoped/computer', headers })).json()).toMatchObject({ computerId: 'cmp_a', handoff: null });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('a computer a chat runs in its own process', { timeout: 30_000 }, () => {
  it('is listed as such, and a take-over says where to go instead', async () => {
    harness = await buildTestApp();
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    expect((await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/in-chat` })).statusCode).toBe(204);
    expect((await harness.app.inject({ method: 'GET', url: '/v1/overview' })).json().inChat).toEqual([id]);
    const taken = await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover` });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toMatchObject({ code: 'E_COMPUTER_IN_CHAT', hint: expect.stringContaining('computer_open_ui') });
  });
});
