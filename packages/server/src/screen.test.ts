import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

let harness: TestApp;
let socket: WebSocket | undefined;

afterEach(async () => {
  socket?.close();
  socket = undefined;
  await harness?.cleanup();
});

function first(ws: WebSocket): Promise<{ type: string; [k: string]: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message')), 10_000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
    ws.once('error', reject);
  });
}

async function listen(): Promise<number> {
  harness = await buildTestApp();
  await harness.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = harness.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

// A real frame needs Chromium running in a computer, which these tests do not
// start. They cover the parts that must never launch one.
describe('WS /v1/computers/:id/screen', { timeout: 30_000 }, () => {
  it('says there is no browser yet, and does not start one', async () => {
    const port = await listen();
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/computers/${id}/screen`);
    expect(await first(socket)).toMatchObject({ type: 'idle' });
  });

  it('lists no tabs where no browser is open, without starting one or counting as use', async () => {
    harness = await buildTestApp();
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    const before = (await harness.app.inject({ method: 'GET', url: `/v1/computers/${id}` })).json().lastUsedAt;
    const res = await harness.app.inject({ method: 'GET', url: `/v1/computers/${id}/browser/tabs` });
    expect(res.json()).toEqual({ tabs: [] });
    expect((await harness.app.inject({ method: 'GET', url: `/v1/computers/${id}` })).json().lastUsedAt).toBe(before);
    expect((await harness.app.inject({ method: 'GET', url: '/v1/computers/cmp_nope/browser/tabs' })).statusCode).toBe(404);
  });

  it('names a computer that does not exist, then closes', async () => {
    const port = await listen();
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/computers/cmp_nope/screen`);
    expect(await first(socket)).toMatchObject({ type: 'error', code: 'E_COMPUTER_NOT_FOUND' });
  });
});
