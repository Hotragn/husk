import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandoffRegistry } from './handoffs.js';
import { buildTestApp, fakeAgentFactory, sampleSpec, type TestApp } from './testing.js';

function raise(registry: HandoffRegistry, signal = new AbortController().signal) {
  const raised: Array<{ handoffId: string; reason: string }> = [];
  const outcome = registry.request({ runId: 'run_1', husk: 'h', reason: 'Sign in', signal }, (p) => raised.push(p));
  return { outcome, raised, signal };
}

describe('HandoffRegistry', () => {
  afterEach(() => vi.useRealTimers());

  it('stays paused indefinitely: no timer and no dropped viewer resolves it', async () => {
    vi.useFakeTimers();
    const registry = new HandoffRegistry();
    const { outcome, raised } = raise(registry);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(raised).toHaveLength(1);
    expect(registry.list()).toHaveLength(1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
  });

  it('resumes as done only when the person completes it, and clears the list', async () => {
    const registry = new HandoffRegistry();
    const { outcome, raised } = raise(registry);
    const done = registry.complete(raised[0]!.handoffId);
    expect(done).toMatchObject({ runId: 'run_1', reason: 'Sign in' });
    await expect(outcome).resolves.toBe('done');
    expect(registry.list()).toHaveLength(0);
  });

  it('ends as aborted when the run is cancelled', async () => {
    const registry = new HandoffRegistry();
    const controller = new AbortController();
    const { outcome } = raise(registry, controller.signal);
    controller.abort();
    await expect(outcome).resolves.toBe('aborted');
    expect(registry.list()).toHaveLength(0);
  });

  it('refuses to wait at all when the run is already aborted', async () => {
    const registry = new HandoffRegistry();
    const controller = new AbortController();
    controller.abort();
    const { outcome, raised } = raise(registry, controller.signal);
    await expect(outcome).resolves.toBe('aborted');
    expect(raised).toHaveLength(0);
  });

  it('cannot be completed twice, and an unknown id is a 404 not a silent success', async () => {
    const registry = new HandoffRegistry();
    const { raised } = raise(registry);
    registry.complete(raised[0]!.handoffId);
    expect(() => registry.complete(raised[0]!.handoffId)).toThrow(/no handoff/);
    expect(() => registry.complete('hnd_missing')).toThrow(/no handoff/);
  });

  it('denyAll ends every wait so shutdown leaves no run parked', async () => {
    const registry = new HandoffRegistry();
    const a = raise(registry);
    const b = raise(registry);
    expect(registry.denyAll()).toBe(2);
    await expect(a.outcome).resolves.toBe('aborted');
    await expect(b.outcome).resolves.toBe('aborted');
  });
});

describe('handoff over HTTP', () => {
  let harness: TestApp | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('pauses a run until POST .../done, and shows the reason while it waits', async () => {
    harness = await buildTestApp({ agent: fakeAgentFactory({ handoffFor: { reason: 'Enter the 2FA code' } }) });
    await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec() } });

    const inflight = harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'go' } });

    let waiting = await harness.app.inject({ method: 'GET', url: '/v1/handoffs' });
    for (let i = 0; i < 300 && waiting.json().handoffs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      waiting = await harness.app.inject({ method: 'GET', url: '/v1/handoffs' });
    }
    const [handoff] = waiting.json().handoffs;
    expect(handoff.handoffId).toMatch(/^hnd_/);
    expect(handoff.reason).toBe('Enter the 2FA code');

    const answered = await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoff.handoffId}/done` });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual({ handoffId: handoff.handoffId, outcome: 'done' });

    const result = await inflight;
    expect(result.statusCode).toBe(200);
  });

  it('streams handoff_required while the run is still paused, not after the person answers', async () => {
    harness = await buildTestApp({ agent: fakeAgentFactory({ handoffFor: { reason: 'Enter the 2FA code' } }) });
    const runner = harness.app.husk.runner;
    const events = runner.stream(sampleSpec(), { input: 'go' }, new AbortController().signal)[Symbol.asyncIterator]();
    let e = await events.next();
    while (!e.done && e.value.type !== 'handoff_required') e = await events.next();
    expect(e.done ? undefined : e.value.type).toBe('handoff_required');
    // The event arrived with the handoff still open: nobody has answered yet.
    const open = runner.handoffs.list();
    expect(open).toHaveLength(1);
    runner.handoffs.complete(open[0]!.handoffId);
    let last: string | undefined;
    for (let r = await events.next(); !r.done; r = await events.next()) last = r.value.type;
    expect(last).toBe('run_end');
  });

  it('answers an unknown handoff with a 404 and the hint', async () => {
    harness = await buildTestApp();
    const res = await harness.app.inject({ method: 'POST', url: '/v1/handoffs/hnd_nope/done' });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.json())).toMatch(/GET \/v1\/handoffs/);
  });

  it('requires the server token: a handoff cannot be resumed by an unauthenticated caller', async () => {
    harness = await buildTestApp({ token: 'test-token-0123456789' });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/handoffs/hnd_any/done' });
    expect(res.statusCode).toBe(401);
    const list = await harness.app.inject({ method: 'GET', url: '/v1/handoffs' });
    expect(list.statusCode).toBe(401);
  });
});
