import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ctxOf } from './context.js';
import { buildTestApp, fakeAgentFactory, sampleSpec, type TestApp } from './testing.js';

const page = {
  frame: vi.fn(async () => ({ data: Buffer.from('jpeg-bytes').toString('base64'), width: 1280, height: 720 })),
  clickAt: vi.fn(async () => {}),
  wheelAt: vi.fn(async () => {}),
  insertText: vi.fn(async () => {}),
  press: vi.fn(async () => {}),
};
const live = { on: true };
// Hoisted: the mock factory below reads it when the module loads, not when called.
const markUsedFor = vi.hoisted(() => vi.fn());

vi.mock('@husk-ai/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@husk-ai/browser')>();
  return { ...actual, markUsedFor, livePageFor: (id: string) => (live.on && id === 'cmp_1' ? page : undefined) };
});

let harness: TestApp | undefined;
let inflight: Promise<unknown> | undefined;

async function openHandoff(opts: { token?: string; computerId?: string } = {}): Promise<string> {
  harness = await buildTestApp({
    agent: fakeAgentFactory({ handoffFor: { reason: 'Sign in', computerId: opts.computerId ?? 'cmp_1' } }),
    ...(opts.token ? { token: opts.token } : {}),
  });
  const headers = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec() }, headers });
  inflight = harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'go' }, headers });
  for (let i = 0; i < 300; i++) {
    const list = ctxOf(harness.app).runner.handoffs.list();
    if (list[0]) return list[0].handoffId;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('handoff never opened');
}

function input(id: string, payload: unknown, headers: Record<string, string> = {}) {
  return harness!.app.inject({ method: 'POST', url: `/v1/handoffs/${id}/input`, payload: payload as object, headers });
}

beforeEach(() => {
  live.on = true;
  for (const fn of Object.values(page)) fn.mockClear();
  markUsedFor.mockClear();
});

afterEach(async () => {
  if (harness) ctxOf(harness.app).runner.handoffs.denyAll();
  await inflight;
  await harness?.cleanup();
  harness = undefined;
  inflight = undefined;
});

describe('handoff viewer', () => {
  it('serves a frame of the live page, with its viewport and no caching', async () => {
    const id = await openHandoff();
    const res = await harness!.app.inject({ method: 'GET', url: `/v1/handoffs/${id}/screen` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-husk-viewport']).toBe('1280x720');
    expect(res.rawPayload.toString()).toBe('jpeg-bytes');
  });

  it('counts a person’s input as using the computer, and their watching as not', async () => {
    // Without this a long 2FA in a take-over is idle time, and the reaper takes
    // the computer while the person types.
    const id = await openHandoff();
    await harness!.app.inject({ method: 'GET', url: `/v1/handoffs/${id}/screen` });
    expect(markUsedFor).not.toHaveBeenCalled();
    await input(id, { type: 'text', text: '913377' });
    expect(markUsedFor).toHaveBeenCalledWith('cmp_1');
  });

  it('says there is no browser rather than launching one', async () => {
    const id = await openHandoff();
    live.on = false;
    const res = await harness!.app.inject({ method: 'GET', url: `/v1/handoffs/${id}/screen` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('E_BROWSER_NOT_FOUND');
  });

  it('sends mouse, wheel, text and named keys to the page', async () => {
    const id = await openHandoff();
    expect((await input(id, { type: 'click', x: 10, y: 20 })).statusCode).toBe(204);
    expect(page.clickAt).toHaveBeenCalledWith(10, 20, { button: 'left', clickCount: 1 });
    await input(id, { type: 'click', x: 1, y: 2, button: 'right', double: true });
    expect(page.clickAt).toHaveBeenLastCalledWith(1, 2, { button: 'right', clickCount: 2 });
    await input(id, { type: 'scroll', x: 5, y: 5, dy: 300 });
    expect(page.wheelAt).toHaveBeenCalledWith(5, 5, 0, 300);
    await input(id, { type: 'text', text: 'hunter2' });
    expect(page.insertText).toHaveBeenCalledWith('hunter2');
    await input(id, { type: 'key', key: 'Enter' });
    expect(page.press).toHaveBeenCalledWith('Enter');
  });

  it('refuses anything outside the closed list and never touches the page', async () => {
    const id = await openHandoff();
    const bad: unknown[] = [
      { type: 'eval', expression: 'document.cookie' },
      { type: 'navigate', url: 'https://example.com' },
      { type: 'click', x: 1, y: 1, method: 'Runtime.evaluate' },
      { type: 'click', x: -1, y: 1 },
      { type: 'click', x: Number.MAX_SAFE_INTEGER, y: 1 },
      { type: 'text', text: '' },
      { type: 'text', text: 'x'.repeat(2001) },
      { type: 'key', key: 'F12' },
      { type: 'key', key: 'a' },
      {},
    ];
    for (const payload of bad) {
      const res = await input(id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
    for (const fn of Object.values(page)) expect(fn).not.toHaveBeenCalled();
  });

  it('keeps typed text off the event bus, where passwords and codes would leak', async () => {
    const id = await openHandoff();
    await input(id, { type: 'text', text: 'one-time-code-913377' });
    expect(JSON.stringify(ctxOf(harness!.app).bus.history())).not.toContain('913377');
  });

  it('ends viewer access the moment the handoff is done', async () => {
    const id = await openHandoff();
    await harness!.app.inject({ method: 'POST', url: `/v1/handoffs/${id}/done` });
    expect((await harness!.app.inject({ method: 'GET', url: `/v1/handoffs/${id}/screen` })).statusCode).toBe(404);
    expect((await input(id, { type: 'click', x: 1, y: 1 })).statusCode).toBe(404);
    expect(page.clickAt).not.toHaveBeenCalled();
  });

  it('shows nothing for a handoff on a different computer', async () => {
    const id = await openHandoff({ computerId: 'cmp_other' });
    expect((await harness!.app.inject({ method: 'GET', url: `/v1/handoffs/${id}/screen` })).statusCode).toBe(404);
  });

  it('requires the server token for the screen and for input', async () => {
    const id = await openHandoff({ token: 'test-token-0123456789' });
    expect((await harness!.app.inject({ method: 'GET', url: `/v1/handoffs/${id}/screen` })).statusCode).toBe(401);
    expect((await input(id, { type: 'text', text: 'x' })).statusCode).toBe(401);
    const wrong = { authorization: 'Bearer wrong-token-0123456789' };
    expect((await input(id, { type: 'text', text: 'x' }, wrong)).statusCode).toBe(401);
    expect(page.insertText).not.toHaveBeenCalled();
  });
});
