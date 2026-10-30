import type { RunEvent } from '@husk-ai/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_RUN, ComputerControl, HandoffRegistry, PERSON_RUN, refusalText } from './handoffs.js';
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

  it('keeps the browser open under every hold, however long, and stops when it ends', () => {
    vi.useFakeTimers();
    try {
      const touched: string[] = [];
      const registry = new HandoffRegistry({ keepAlive: (id) => touched.push(id) });
      const chat = new AbortController();
      const person = new AbortController();
      void registry.request({ runId: CHAT_RUN, husk: 'chat', reason: 'Sign in', computerId: 'c1', signal: chat.signal }, () => {});
      void registry.request({ runId: PERSON_RUN, husk: 'you', reason: 'You took over this computer', computerId: 'c2', signal: person.signal }, () => {});
      // Past the browser's five idle minutes, with nobody watching.
      vi.advanceTimersByTime(6 * 60_000);
      expect(touched.filter((id) => id === 'c1')).toHaveLength(6);
      expect(touched.filter((id) => id === 'c2')).toHaveLength(6);
      chat.abort();
      person.abort();
      vi.advanceTimersByTime(10 * 60_000);
      expect(touched).toHaveLength(12);
    } finally {
      vi.useRealTimers();
    }
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
    const runId = e.done || e.value.type !== 'run_start' ? undefined : e.value.runId;
    while (!e.done && e.value.type !== 'handoff_required') e = await events.next();
    expect(e.done ? undefined : e.value.type).toBe('handoff_required');
    // The event arrived with the handoff still open: nobody has answered yet.
    const open = runner.handoffs.list();
    expect(open).toHaveLength(1);
    // The run's own id, the one run_start and /v1/runs give, and the handoff to answer.
    expect(e.value).toMatchObject({ handoffId: open[0]!.handoffId, request: { runId } });
    expect(runId).toMatch(/^run_/);
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

describe('ComputerControl', () => {
  const page = (url: string, title = 'T', tab = 'tab1') => ({ tab, url, title });
  const none = async () => undefined;

  it('stops the calls on the computer a person takes, and only those', async () => {
    const control = new ComputerControl();
    const mine = control.start('c1', 'shell');
    const other = control.start('c2', 'shell');
    const stopping = control.stop('c1');
    expect(mine.signal.aborted).toBe(true);
    expect(mine.takenOver()).toBe(true);
    expect(other.signal.aborted).toBe(false);
    mine.done();
    expect(await stopping).toEqual(['shell']);
    other.done();
    expect(await control.stop('c1')).toEqual([]);
  });

  it('says what the AI is running on each computer, the oldest call first, until it ends', () => {
    const control = new ComputerControl();
    const first = control.start('c1', 'browser_goto');
    const second = control.start('c1', 'shell');
    expect(control.inFlight()).toEqual({ c1: { tool: 'browser_goto', since: expect.any(String) } });
    first.done();
    expect(control.inFlight()['c1']?.tool).toBe('shell');
    second.done();
    expect(control.inFlight()).toEqual({});
  });

  it('aborts on the caller’s own signal too, without calling that a take-over', () => {
    const cancel = new AbortController();
    const call = new ComputerControl().start('c1', 'shell', cancel.signal);
    cancel.abort();
    expect(call.signal.aborted).toBe(true);
    expect(call.takenOver()).toBe(false);
    call.done();
  });

  it('waits for stopped calls to end, but not for ever', async () => {
    const control = new ComputerControl();
    control.start('c1', 'browser_script');
    const started = Date.now();
    expect(await control.stop('c1', 50)).toEqual(['browser_script']);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('after Give back refuses a page action only when the page changed, saying what changed', async () => {
    const control = new ComputerControl();
    control.mark('c1', page('https://a.test/'), false);
    expect(await control.refusal('c1', 'browser_click', async () => page('https://a.test/'))).toBeUndefined();

    control.mark('c1', page('https://a.test/', 'A'), false);
    const why = await control.refusal('c1', 'browser_click', async () => page('https://b.test/', 'B'));
    expect(why).toContain('"B" at https://b.test/');
    expect(why).toContain('"A" at https://a.test/');
    // Still refused until it looks again. Reads and commands run meanwhile.
    expect(await control.refusal('c1', 'browser_type', none)).toBe(why);
    expect(await control.refusal('c1', 'browser_wait_for', none)).toBeUndefined();
    expect(await control.refusal('c1', 'shell', none)).toBeUndefined();
    expect(await control.refusal('c1', 'browser_snapshot', none)).toBeUndefined();
    expect(await control.refusal('c1', 'browser_click', none)).toBeUndefined();
  });

  it('says so when the person moved to another tab', async () => {
    const control = new ComputerControl();
    control.mark('c1', page('https://a.test/'), false);
    expect(await control.refusal('c1', 'browser_run', async () => page('https://a.test/', 'T', 'tab2'))).toContain('in another tab');
  });

  it('after a browser call stopped part-way, refuses page actions until a fresh look', async () => {
    const control = new ComputerControl();
    control.mark('c1', undefined, true);
    expect(await control.refusal('c1', 'browser_click', none)).toContain('stopped part-way');
    expect(await control.refusal('c1', 'browser_goto', none)).toBeUndefined();
    expect(await control.refusal('c1', 'browser_click', none)).toBeUndefined();
  });

  it('compares with the page the AI last saw, across a second take-over', async () => {
    const control = new ComputerControl();
    control.mark('c1', page('https://a.test/'), false);
    control.mark('c1', page('https://b.test/'), false);
    expect(await control.refusal('c1', 'browser_click', async () => page('https://b.test/'))).toContain('https://a.test/');
  });
});

describe('a husk run on a computer a person holds', { timeout: 30_000 }, () => {
  let harness: TestApp | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  /** A run whose computer tool goes onto cmp_1, the fake manager's first computer, taken over first or not. */
  async function run(take: boolean, signal = new AbortController().signal) {
    const h = (harness = await buildTestApp({ agent: fakeAgentFactory({ toolOn: { computerId: 'cmp_1', name: 'shell' } }) }));
    const { id } = (await h.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    expect(id).toBe('cmp_1');
    const handoffId = take ? ((await h.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover` })).json() as { handoffId: string }).handoffId : '';
    const seen: RunEvent[] = [];
    const done = (async () => {
      for await (const e of h.app.husk.runner.stream(sampleSpec(), { input: 'go' }, signal)) seen.push(e);
    })();
    return { h, handoffId, seen, done };
  }
  const paused = (seen: RunEvent[]) => seen.filter((e) => e.type === 'warning' && /^Paused: a person took over/.test(e.message));

  it('pauses, says so once, and goes on when the person gives the computer back (J5-e)', async () => {
    const { h, handoffId, seen, done } = await run(true);
    await vi.waitFor(() => expect(paused(seen)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 600));
    expect(paused(seen)).toHaveLength(1);
    expect(seen.some((e) => e.type === 'tool_end')).toBe(false);
    await h.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done`, headers: { 'x-husk-as': 'person' } });
    await done;
    expect(seen.find((e) => e.type === 'tool_end')).toMatchObject({ output: 'ran' });
    expect(seen.at(-1)?.type).toBe('run_end');
  });

  it('ends, its tool never run, when the run is cancelled while it waits', async () => {
    const abort = new AbortController();
    const { seen, done } = await run(true, abort.signal);
    await vi.waitFor(() => expect(paused(seen)).toHaveLength(1));
    abort.abort();
    await done;
    expect(seen.some((e) => e.type === 'tool_end' && e.output === 'ran')).toBe(false);
  });

  it('runs its tools as before when nobody holds the computer', async () => {
    const { seen, done } = await run(false);
    await done;
    expect(seen.find((e) => e.type === 'tool_end')).toMatchObject({ output: 'ran' });
    expect(paused(seen)).toHaveLength(0);
  });
});

describe('a tool call on a held computer', () => {
  it('opens with a code that stays the same whatever the wording, saying who has it', () => {
    expect(refusalText({ handoffId: 'hnd_1', runId: PERSON_RUN, reason: 'You took over this computer' })).toMatch(
      /^E_COMPUTER_HELD \(person\): The user took over this computer/,
    );
    expect(refusalText({ handoffId: 'hnd_2', runId: CHAT_RUN, reason: 'sign in to GitHub' })).toMatch(
      /^E_COMPUTER_HELD \(handoff\): The user has the computer right now \(handoff hnd_2: sign in to GitHub\)/,
    );
  });
});
