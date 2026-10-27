import { afterEach, describe, expect, it } from 'vitest';
import type { AgentFactory, ServerRunOptions } from './deps.js';
import { FakeRouter, buildTestApp, sampleSpec } from './testing.js';
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
});
