import { afterEach, describe, expect, it } from 'vitest';
import type { AgentFactory, ServerRunOptions } from './deps.js';
import { FakeRouter, buildTestApp, fakeAgentFactory, sampleSpec } from './testing.js';
import type { TestApp } from './testing.js';

let harness: TestApp | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('a run started over the API', () => {
  it('is held to the husk’s own step limit, and its router gets the husk’s fallbackModels', async () => {
    const router = new FakeRouter();
    let seen: ServerRunOptions | undefined;
    // An agent that makes one model call through the router it was given.
    const agent: AgentFactory = async (init) => ({
      async run(opts) {
        seen = opts;
        await init.router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
        return { runId: 'r', text: 'ok', messages: [], steps: 1, usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, stopReason: 'complete' };
      },
      async *stream() {},
    });
    harness = await buildTestApp({ router, agent });
    const spec = { ...sampleSpec(), limits: { ...sampleSpec().limits, maxSteps: 5 }, fallbackModels: ['ollama/qwen2.5:7b'] };
    expect((await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec } })).statusCode).toBeLessThan(300);

    const ran = await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'go', maxSteps: 500 } });
    expect(ran.statusCode).toBe(200);
    expect(seen?.maxSteps).toBe(5);
    expect(router.requests[0]).toMatchObject({ fallbacks: ['ollama/qwen2.5:7b'] });

    await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'go', maxSteps: 2 } });
    expect(seen?.maxSteps).toBe(2);
  });

  it('streams an approval under the run’s own id, with the call it is for', async () => {
    const call = { id: 'call_7', name: 'shell', args: { command: 'ls' } };
    harness = await buildTestApp({ agent: fakeAgentFactory({ approvalFor: call }) });
    const runner = harness.app.husk.runner;
    const spec = { ...sampleSpec(), guardrails: { ...sampleSpec().guardrails, approvalMode: 'ask' as const } };
    const events = runner.stream(spec, { input: 'go' }, new AbortController().signal)[Symbol.asyncIterator]();
    let e = await events.next();
    const runId = e.done || e.value.type !== 'run_start' ? undefined : e.value.runId;
    while (!e.done && e.value.type !== 'approval_required') e = await events.next();
    expect(runId).toMatch(/^run_/);
    expect(e.value).toMatchObject({ type: 'approval_required', request: { runId, callId: 'call_7' } });
    const [pending] = runner.approvals.list();
    expect(pending).toMatchObject({ runId, call: { id: 'call_7' } });
    runner.approvals.answer(pending!.approvalId, false);
    for (let r = await events.next(); !r.done; r = await events.next());
  });
});
