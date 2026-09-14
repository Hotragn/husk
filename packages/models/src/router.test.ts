import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider, StreamEvent } from '@husk/core';
import { HuskError, createLogger } from '@husk/core';
import { describe, expect, it } from 'vitest';
import { ModelRouter, defaultProviders, type RouterStreamEvent } from './router.js';
import { findModel } from './catalog.js';
import { hangingFetch } from './testing.js';
import { AnthropicProvider } from './providers/anthropic.js';
import type { FetchLike } from './providers/openai-compatible.js';

const silent = createLogger({ level: 'silent' });

interface FakeOptions {
  id: string;
  priority?: number;
  models?: ModelInfo[];
  available?: boolean;
  reason?: string;
  hint?: string;
  /** Thrown on every attempt until `failures` is exhausted. */
  error?: () => unknown;
  failures?: number;
  text?: string;
  /** Awaited between the two text deltas, to prove streaming is incremental. */
  gate?: Promise<void>;
}

class FakeProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly priority: number;
  calls = 0;
  streams = 0;
  lastRequest: ChatRequest | undefined;
  private remainingFailures: number;

  constructor(private readonly opts: FakeOptions) {
    this.id = opts.id;
    this.displayName = opts.id;
    this.priority = opts.priority ?? 50;
    this.remainingFailures = opts.failures ?? (opts.error ? Number.POSITIVE_INFINITY : 0);
  }

  async isAvailable() {
    if (this.opts.available === false) {
      return {
        available: false,
        reason: this.opts.reason ?? 'not configured',
        hint: this.opts.hint ?? `configure ${this.id}`,
      };
    }
    return { available: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.opts.models ?? [fakeModel(this.id, 'model-a', { quality: 50 })];
  }

  private failIfDue(): void {
    if (this.remainingFailures > 0 && this.opts.error) {
      this.remainingFailures--;
      throw this.opts.error();
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    this.lastRequest = req;
    this.failIfDue();
    return {
      model: req.model,
      text: this.opts.text ?? `hello from ${this.id}`,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 1,
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.streams++;
    this.lastRequest = req;
    this.failIfDue();
    yield { type: 'start', model: req.model };
    yield { type: 'text_delta', text: 'first ' };
    if (this.opts.gate) await this.opts.gate;
    yield { type: 'text_delta', text: 'second' };
    yield {
      type: 'done',
      response: {
        model: req.model,
        text: 'first second',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
        latencyMs: 1,
      },
    };
  }
}

function fakeModel(provider: string, name: string, extra: Partial<ModelInfo> & { quality?: number } = {}): ModelInfo {
  return {
    id: `${provider}/${name}`,
    provider,
    name,
    displayName: name,
    contextWindow: 100_000,
    maxOutputTokens: 4_096,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    ...extra,
  } as ModelInfo;
}

function status(code: number): HuskError {
  return new HuskError('E_MODEL_ERROR', `upstream ${code}`, { details: { status: code, retryable: code >= 500 || code === 429 } });
}

const ask = { messages: [{ role: 'user' as const, content: 'hello' }] };

async function drain(iter: AsyncIterable<RouterStreamEvent>): Promise<RouterStreamEvent[]> {
  const out: RouterStreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe('detect', () => {
  it('reports every provider, with a reason and a hint for the unusable ones', async () => {
    const router = new ModelRouter({
      logger: silent,
      providers: [
        new FakeProvider({ id: 'anthropic', priority: 95, available: false, reason: 'no key', hint: 'set ANTHROPIC_API_KEY' }),
        new FakeProvider({ id: 'ollama', priority: 40 }),
      ],
    });
    const report = await router.detect();

    expect(report.providers).toHaveLength(2);
    expect(report.providers[0]).toMatchObject({ id: 'anthropic', available: false, reason: 'no key', hint: 'set ANTHROPIC_API_KEY' });
    expect(report.available).toEqual(['ollama']);
    expect(report.recommended).toBe('ollama/model-a');
  });

  it('leads with the free local path when nothing at all is configured', async () => {
    const router = new ModelRouter({
      logger: silent,
      providers: [
        new FakeProvider({ id: 'anthropic', available: false }),
        new FakeProvider({ id: 'ollama', available: false }),
      ],
    });
    const report = await router.detect();
    expect(report.available).toEqual([]);
    expect(report.recommended).toBeUndefined();
    expect(report.hints[0]).toContain('ollama pull qwen2.5:7b');
  });

  it('nudges towards a free fallback when only paid providers work', async () => {
    const router = new ModelRouter({
      logger: silent,
      providers: [new FakeProvider({ id: 'anthropic', models: [fakeModel('anthropic', 'x')] })],
    });
    const report = await router.detect();
    expect(report.hints.some((h) => h.includes('ollama pull qwen2.5:7b'))).toBe(true);
  });

  it('caches for the configured window and refreshes on force', async () => {
    const provider = new FakeProvider({ id: 'ollama' });
    let probes = 0;
    const counting = Object.assign(provider, {
      isAvailable: async () => {
        probes++;
        return { available: true };
      },
    });
    const router = new ModelRouter({ logger: silent, providers: [counting], detectTtlMs: 30_000 });
    await router.detect();
    await router.detect();
    expect(probes).toBe(1);
    await router.detect({ force: true });
    expect(probes).toBe(2);
  });

  it('treats a provider that throws as unavailable rather than failing the report', async () => {
    const exploding: ModelProvider = {
      id: 'boom',
      displayName: 'Boom',
      priority: 10,
      isAvailable: async () => {
        throw new Error('kaboom');
      },
      listModels: async () => [],
      chat: async () => {
        throw new Error('unused');
      },
      stream: async function* () {},
    };
    const report = await new ModelRouter({ logger: silent, providers: [exploding] }).detect();
    expect(report.providers[0]).toMatchObject({ available: false, reason: 'kaboom' });
  });
});

describe('auto and free', () => {
  const anthropic = new FakeProvider({
    id: 'anthropic',
    priority: 95,
    models: [fakeModel('anthropic', 'big', { quality: 100, pricing: { inputPerMTok: 5, outputPerMTok: 25 } })],
  });
  const ollama = new FakeProvider({
    id: 'ollama',
    priority: 40,
    models: [fakeModel('ollama', 'gemma3', { quality: 45, free: true, pricing: { inputPerMTok: 0, outputPerMTok: 0 } })],
  });

  it('auto considers configured API keys, not just Ollama', async () => {
    const router = new ModelRouter({ logger: silent, providers: [anthropic, ollama] });
    const chosen = await router.resolveProvider('auto');
    expect(chosen.id).toBe('anthropic/big');
  });

  it('free picks the zero-cost model even when a better one is configured', async () => {
    const router = new ModelRouter({ logger: silent, providers: [anthropic, ollama] });
    expect((await router.resolveProvider('free')).id).toBe('ollama/gemma3');
  });

  it('local only ever picks a local provider', async () => {
    const router = new ModelRouter({ logger: silent, providers: [anthropic, ollama] });
    expect((await router.resolveProvider('local')).id).toBe('ollama/gemma3');
  });

  it('falls back to Ollama when the only key is missing', async () => {
    const router = new ModelRouter({
      logger: silent,
      providers: [new FakeProvider({ id: 'anthropic', available: false }), ollama],
    });
    expect((await router.resolveProvider('auto')).id).toBe('ollama/gemma3');
  });

  it('explains itself when nothing is available', async () => {
    const router = new ModelRouter({
      logger: silent,
      providers: [new FakeProvider({ id: 'anthropic', available: false, hint: 'set ANTHROPIC_API_KEY' })],
    });
    await expect(router.chat({ model: 'auto', ...ask })).rejects.toThrowError(HuskError);
    try {
      await router.chat({ model: 'auto', ...ask });
    } catch (err) {
      expect((err as HuskError).code).toBe('E_MODEL_UNAVAILABLE');
      expect((err as HuskError).hint).toContain('ollama pull qwen2.5:7b');
    }
  });
});

describe('fallback', () => {
  it('moves to the next provider on a 429 and reports which one answered', async () => {
    const failing = new FakeProvider({ id: 'anthropic', priority: 95, error: () => status(429) });
    const working = new FakeProvider({ id: 'ollama', priority: 40, models: [fakeModel('ollama', 'gemma3', { free: true })] });
    const router = new ModelRouter({ logger: silent, providers: [failing, working], attempts: 1 });

    const response = await router.chat({ model: 'anthropic/model-a', ...ask });
    expect(response.model).toBe('ollama/gemma3');
    expect(failing.calls).toBe(1);
  });

  it('retries the same provider before moving on', async () => {
    const flaky = new FakeProvider({ id: 'anthropic', priority: 95, error: () => status(503), failures: 2 });
    const router = new ModelRouter({ logger: silent, providers: [flaky], attempts: 3 });
    const response = await router.chat({ model: 'anthropic/model-a', ...ask });
    expect(flaky.calls).toBe(3);
    expect(response.text).toContain('anthropic');
  });

  it('never retries a 400, and never shops it to another provider', async () => {
    const bad = new FakeProvider({ id: 'anthropic', priority: 95, error: () => status(400) });
    const other = new FakeProvider({ id: 'ollama', priority: 40 });
    const router = new ModelRouter({ logger: silent, providers: [bad, other], attempts: 3 });

    await expect(router.chat({ model: 'anthropic/model-a', ...ask })).rejects.toThrowError(/upstream 400/);
    expect(bad.calls).toBe(1);
    expect(other.calls).toBe(0);
  });

  it('does not retry a 401, but does try another provider', async () => {
    const unauthorised = new FakeProvider({
      id: 'anthropic',
      priority: 95,
      error: () => new HuskError('E_NO_CREDENTIALS', 'bad key', { details: { status: 401, retryable: false } }),
    });
    const other = new FakeProvider({ id: 'ollama', priority: 40 });
    const router = new ModelRouter({ logger: silent, providers: [unauthorised, other], attempts: 3 });

    const response = await router.chat({ model: 'anthropic/model-a', ...ask });
    expect(unauthorised.calls).toBe(1);
    expect(response.model).toBe('ollama/model-a');
  });

  it('honours the caller’s explicit fallback order', async () => {
    const failing = new FakeProvider({ id: 'anthropic', priority: 95, error: () => status(500) });
    const groq = new FakeProvider({ id: 'groq', priority: 60, models: [fakeModel('groq', 'llama')] });
    const ollama = new FakeProvider({ id: 'ollama', priority: 40 });
    const router = new ModelRouter({ logger: silent, providers: [failing, groq, ollama], attempts: 1 });

    const response = await router.chat({ model: 'anthropic/model-a', fallbacks: ['ollama/model-a'], ...ask });
    expect(response.model).toBe('ollama/model-a');
    expect(groq.calls).toBe(0);
  });

  it('reports every candidate it tried once they all fail', async () => {
    const a = new FakeProvider({ id: 'anthropic', priority: 95, error: () => status(500) });
    const b = new FakeProvider({ id: 'ollama', priority: 40, error: () => status(503) });
    const router = new ModelRouter({ logger: silent, providers: [a, b], attempts: 1 });

    try {
      await router.chat({ model: 'auto', ...ask });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as HuskError).message).toContain('all 2 candidates failed');
      expect((err as HuskError).details).toMatchObject({ tried: ['anthropic/model-a', 'ollama/model-a'] });
    }
  });
});

describe('stream', () => {
  it('yields text as it arrives rather than after the response completes', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const provider = new FakeProvider({ id: 'ollama', gate });
    const router = new ModelRouter({ logger: silent, providers: [provider] });

    const iterator = router.stream({ model: 'ollama/model-a', ...ask })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'start' });
    expect((await iterator.next()).value).toEqual({ type: 'text_delta', text: 'first ' });

    // The provider is still blocked; the first delta already reached the caller.
    open();
    expect((await iterator.next()).value).toEqual({ type: 'text_delta', text: 'second' });
  });

  it('warns before it downgrades, naming both models', async () => {
    const failing = new FakeProvider({ id: 'anthropic', priority: 95, error: () => status(429) });
    const working = new FakeProvider({ id: 'ollama', priority: 40, models: [fakeModel('ollama', 'gemma3', { free: true })] });
    const router = new ModelRouter({ logger: silent, providers: [failing, working], attempts: 1 });

    const events = await drain(router.stream({ model: 'anthropic/model-a', ...ask }));
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(warning).toMatchObject({
      type: 'warning',
      code: 'fallback',
      detail: { from: 'anthropic/model-a', to: 'ollama/gemma3' },
    });
    expect((warning as { message: string }).message).toContain('falling back');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('ends in an error event when every candidate fails', async () => {
    const failing = new FakeProvider({ id: 'ollama', error: () => status(500) });
    const router = new ModelRouter({ logger: silent, providers: [failing], attempts: 1 });
    const events = await drain(router.stream({ model: 'ollama/model-a', ...ask }));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'E_MODEL_ERROR' } });
  });

  it('prices the response it hands back', async () => {
    const provider = new FakeProvider({
      id: 'anthropic',
      models: [fakeModel('anthropic', 'm', { pricing: { inputPerMTok: 3, outputPerMTok: 15 } })],
    });
    const router = new ModelRouter({ logger: silent, providers: [provider] });
    const events = await drain(router.stream({ model: 'anthropic/m', ...ask }));
    const done = events.find((e) => e.type === 'done') as { response: ChatResponse };
    expect(done.response.usage.costUsd).toBeCloseTo((10 * 3 + 5 * 15) / 1_000_000, 12);
  });
});

describe('budget', () => {
  const expensive = new FakeProvider({
    id: 'anthropic',
    priority: 95,
    models: [fakeModel('anthropic', 'opus', { quality: 100, pricing: { inputPerMTok: 5, outputPerMTok: 25 } })],
  });
  const free = new FakeProvider({
    id: 'ollama',
    priority: 40,
    models: [fakeModel('ollama', 'gemma3', { quality: 45, free: true, pricing: { inputPerMTok: 0, outputPerMTok: 0 } })],
  });

  const longPrompt = { messages: [{ role: 'user' as const, content: 'x'.repeat(4_000_000) }] };

  it('refuses an explicitly requested model whose prompt alone blows the budget', async () => {
    const router = new ModelRouter({ logger: silent, providers: [expensive, free], maxCostUsd: 0.5 });
    try {
      await router.chat({ model: 'anthropic/opus', ...longPrompt });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as HuskError).code).toBe('E_BUDGET_EXCEEDED');
      expect((err as HuskError).hint).toContain('--model free');
    }
    expect(expensive.calls).toBe(0);
  });

  it('lets a per-request ceiling override the router default', async () => {
    const router = new ModelRouter({ logger: silent, providers: [expensive, free], maxCostUsd: 100 });
    await expect(router.chat({ model: 'anthropic/opus', maxCostUsd: 0.01, ...longPrompt })).rejects.toThrowError(
      /E_BUDGET_EXCEEDED|would cost at least/,
    );
  });

  it('lets auto choose an affordable model instead of failing', async () => {
    const router = new ModelRouter({ logger: silent, providers: [expensive, free], maxCostUsd: 0.5 });
    const response = await router.chat({ model: 'auto', ...longPrompt });
    expect(response.model).toBe('ollama/gemma3');
  });

  it('fails with the budget code when nothing is affordable', async () => {
    const router = new ModelRouter({ logger: silent, providers: [expensive], maxCostUsd: 0.000001 });
    try {
      await router.chat({ model: 'auto', ...longPrompt });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as HuskError).code).toBe('E_BUDGET_EXCEEDED');
    }
  });

  it('does not refuse a short prompt', async () => {
    const router = new ModelRouter({ logger: silent, providers: [expensive, free], maxCostUsd: 0.01 });
    const response = await router.chat({ model: 'anthropic/opus', ...ask });
    expect(response.model).toBe('anthropic/opus');
  });
});

describe('abort', () => {
  it('propagates the signal into the provider fetch and surfaces E_ABORTED', async () => {
    const controller = new AbortController();
    const anthropic = new AnthropicProvider({ apiKey: 'sk-ant-test-key-value-long-enough', fetch: hangingFetch });
    const router = new ModelRouter({ logger: silent, providers: [anthropic], attempts: 3 });

    const promise = router.chat({ model: 'anthropic/claude-sonnet-5', signal: controller.signal, ...ask });
    controller.abort();

    try {
      await promise;
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as HuskError).code).toBe('E_ABORTED');
    }
  });

  it('does not retry or fall back after an abort', async () => {
    const controller = new AbortController();
    const aborting = new FakeProvider({
      id: 'anthropic',
      priority: 95,
      error: () => new HuskError('E_ABORTED', 'aborted', { details: { retryable: false } }),
    });
    const other = new FakeProvider({ id: 'ollama', priority: 40 });
    const router = new ModelRouter({ logger: silent, providers: [aborting, other], attempts: 3 });

    await expect(
      router.chat({ model: 'anthropic/model-a', signal: controller.signal, ...ask }),
    ).rejects.toThrowError(/aborted/);
    expect(aborting.calls).toBe(1);
    expect(other.calls).toBe(0);
  });

  it('ends a stream with an aborted error event rather than a silent fallback', async () => {
    const aborting = new FakeProvider({
      id: 'anthropic',
      priority: 95,
      error: () => new HuskError('E_ABORTED', 'aborted', { details: { retryable: false } }),
    });
    const other = new FakeProvider({ id: 'ollama', priority: 40 });
    const router = new ModelRouter({ logger: silent, providers: [aborting, other], attempts: 1 });

    const events = await drain(router.stream({ model: 'anthropic/model-a', ...ask }));
    expect(events.some((e) => e.type === 'warning')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'E_ABORTED' } });
    expect(other.streams).toBe(0);
  });
});

describe('getModelInfo', () => {
  it('resolves an alias through to the catalog entry', async () => {
    const router = new ModelRouter({ logger: silent, providers: [new FakeProvider({ id: 'anthropic' })] });
    expect(await router.getModelInfo('sonnet')).toEqual(findModel('anthropic/claude-sonnet-5'));
  });

  it('returns null for something nobody has heard of', async () => {
    const router = new ModelRouter({ logger: silent, providers: [] });
    expect(await router.getModelInfo('not-a-model')).toBeNull();
  });

  /**
   * The point of this call is to let a caller decide *before* spending anything, so
   * an answer without pricing is not an answer.
   */
  it('carries pricing, so a call can be costed before it is made', async () => {
    const router = new ModelRouter({ logger: silent, providers: [new FakeProvider({ id: 'google' })] });
    for (const alias of ['opus', 'sonnet', 'haiku', 'gpt', 'gemini', 'flash']) {
      const info = await router.getModelInfo(alias);
      expect(info, alias).not.toBeNull();
      expect(info?.pricing?.inputPerMTok, alias).toBeGreaterThan(0);
      expect(info?.pricing?.outputPerMTok, alias).toBeGreaterThan(0);
    }
    expect((await router.getModelInfo('gemma'))?.pricing).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });

  it('resolves a dynamic alias against what is actually reachable', async () => {
    const paid = new FakeProvider({ id: 'anthropic', priority: 95, models: [fakeModel('anthropic', 'big', { quality: 99 })] });
    const free = new FakeProvider({ id: 'ollama', priority: 40, models: [fakeModel('ollama', 'gemma3', { free: true })] });
    const router = new ModelRouter({ logger: silent, providers: [paid, free] });

    expect((await router.getModelInfo('auto'))?.id).toBe('anthropic/big');
    expect((await router.getModelInfo('free'))?.id).toBe('ollama/gemma3');
    expect((await router.getModelInfo('local'))?.id).toBe('ollama/gemma3');
  });
});

/**
 * With no cloud credentials in the environment — the state of a fresh install, and
 * of the machine this suite runs on — every hosted provider must say it is
 * unavailable and name the variable that fixes it. Throwing, hanging, or a bare
 * "not available" all fail the same user in the same way.
 */
describe('the default registry', () => {
  const unreachable: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));

  it('covers every provider the build contract names', () => {
    const ids = defaultProviders({ env: {}, fetch: unreachable }).map((p) => p.id);
    expect(new Set(ids)).toEqual(
      new Set([
        'anthropic',
        'openai',
        'google',
        'groq',
        'openrouter',
        'together',
        'deepseek',
        'mistral',
        'cerebras',
        'ollama',
        'lmstudio',
      ]),
    );
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it('reports each one unavailable with the exact environment variable to set', async () => {
    const expected: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      google: 'GOOGLE_API_KEY',
      groq: 'GROQ_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      together: 'TOGETHER_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      mistral: 'MISTRAL_API_KEY',
      cerebras: 'CEREBRAS_API_KEY',
    };

    for (const provider of defaultProviders({ env: {}, fetch: unreachable })) {
      const availability = await provider.isAvailable();
      expect(availability.available, provider.id).toBe(false);
      expect(availability.hint, provider.id).toBeTruthy();
      const envKey = expected[provider.id];
      if (envKey) expect(availability.hint, provider.id).toContain(envKey);
    }
  });

  it('never lets a dead endpoint turn a doctor run into an exception', async () => {
    const router = new ModelRouter({ logger: silent, env: {}, fetch: unreachable });
    const report = await router.detect();
    expect(report.available).toEqual([]);
    expect(report.providers).toHaveLength(11);
    expect(report.providers.every((p) => p.reason && p.hint)).toBe(true);
    expect(report.hints[0]).toContain('ollama');
  });
});
