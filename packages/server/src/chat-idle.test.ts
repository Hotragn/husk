import { afterEach, describe, expect, it } from 'vitest';
import { stopIdleChats } from './chat-idle.js';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

/**
 * With a shared Husk, it alone stops a chat's idle computer (F-04), and never
 * one a person holds, the AI is working on, or a chat runs in its own process.
 */

let harness: TestApp;
afterEach(async () => {
  await harness?.cleanup();
});

/** Fake computers were last used at 1970, so every one starts idle. */
async function computers(...kinds: Array<'chat' | 'other'>): Promise<string[]> {
  harness = await buildTestApp();
  const ids: string[] = [];
  for (const kind of kinds) {
    const labels = kind === 'chat' ? { 'husk.via': 'mcp' } : {};
    ids.push(((await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: { labels } })).json() as { id: string }).id);
  }
  return ids;
}
const state = (id: string) => harness.manager.computers.get(id)!.info.state;

describe('the shared Husk’s idle stop', { timeout: 30_000 }, () => {
  it('stops a chat’s computer nothing has used for a while, and nothing else', async () => {
    const [idle, recent, other] = await computers('chat', 'chat', 'other');
    harness.manager.computers.get(recent!)!.info.lastUsedAt = new Date().toISOString();
    expect(await stopIdleChats(harness.app.husk)).toEqual([idle]);
    expect([state(idle!), state(recent!), state(other!)]).toEqual(['stopped', 'running', 'running']);
  });

  it('never stops one a person holds, one the AI is working on, or one its chat runs itself', async () => {
    const [held, busy, inChat] = await computers('chat', 'chat', 'chat');
    await harness.app.inject({ method: 'POST', url: `/v1/computers/${held}/takeover` });
    const call = harness.app.husk.runner.handoffs.control.start(busy!, 'shell');
    harness.app.husk.inChat.add(inChat!);
    expect(await stopIdleChats(harness.app.husk)).toEqual([]);
    call.done();
    expect(await stopIdleChats(harness.app.husk)).toEqual([busy]);
  });
});
