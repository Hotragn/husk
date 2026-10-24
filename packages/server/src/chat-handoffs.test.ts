import { afterEach, describe, expect, it, vi } from 'vitest';
import { takeover } from './routes/tools.js';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

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
    await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done` });
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
