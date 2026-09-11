import { HuskError } from '@husk/core';
import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider, StreamEvent } from '@husk/core';

/**
 * Every model provider `@husk/models` implements.
 *
 * Taken from the package's own `defaultProviders()` rather than a list kept
 * here, so a provider added upstream appears in `husk doctor` and `husk models`
 * without a second edit -- and so this command can never report a provider as
 * missing when it actually exists.
 */
export async function buildProviders(): Promise<ModelProvider[]> {
  const m = await import('@husk/models');
  return [...m.defaultProviders()].sort((a, b) => b.priority - a.priority);
}

export interface ResolvedModel {
  provider: ModelProvider;
  info: ModelInfo;
}

/**
 * Resolve a model reference to something that can actually be called.
 *
 * Accepts a fully-qualified `provider/model`, a bare model name, or one of the
 * aliases from the build contract. When it fails, the error lists what *is*
 * reachable -- "no model available" on its own sends people to the docs.
 */
export async function resolveModel(ref: string): Promise<ResolvedModel> {
  const providers = await buildProviders();
  const reachable: Array<{ provider: ModelProvider; models: ModelInfo[] }> = [];
  const rejected: string[] = [];

  for (const p of providers) {
    const a = await p.isAvailable().catch((e: Error) => ({ available: false, reason: e.message }));
    if (!a.available) {
      rejected.push(`${p.id}: ${a.reason ?? 'unavailable'}`);
      continue;
    }
    reachable.push({ provider: p, models: await p.listModels().catch(() => []) });
  }

  if (!reachable.length) {
    throw new HuskError('E_MODEL_UNAVAILABLE', 'no model provider is reachable', {
      hint: 'set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run `ollama serve` for a free local model',
      details: { rejected },
    });
  }

  const wanted = ALIASES[ref] ?? [ref];

  for (const candidate of wanted) {
    const [maybeProvider, ...restParts] = candidate.split('/');
    const bare = restParts.join('/');

    for (const { provider, models } of reachable) {
      if (bare && provider.id !== maybeProvider) continue;
      const target = bare || candidate;
      const hit =
        models.find((m) => m.id === candidate) ??
        models.find((m) => m.name === target) ??
        models.find((m) => m.id.endsWith(`/${target}`));
      if (hit) return { provider, info: hit };
    }
  }

  if (ref === 'auto' || ref === 'free' || ref === 'local') {
    const preferred = ref === 'local' ? reachable.filter((r) => r.provider.id === 'ollama') : reachable;
    for (const { provider, models } of preferred) {
      const free = ref === 'free' ? models.find((m) => m.free) : undefined;
      const chosen = free ?? models[0];
      if (chosen) return { provider, info: chosen };
    }
  }

  const available = reachable.flatMap((r) => r.models.map((m) => m.id));
  throw new HuskError('E_MODEL_UNAVAILABLE', `no reachable model matches "${ref}"`, {
    hint: available.length
      ? `try one of: ${available.slice(0, 6).join(', ')}`
      : 'the provider answered but listed no models -- `ollama pull qwen2.5:7b` if you are using Ollama',
    details: { available, rejected },
  });
}

/** Contract aliases. Each maps to an ordered candidate list. */
const ALIASES: Record<string, string[]> = {
  opus: ['anthropic/claude-opus-5', 'anthropic/claude-3-opus-20240229'],
  sonnet: ['anthropic/claude-sonnet-5', 'anthropic/claude-3-7-sonnet-20250219', 'anthropic/claude-3-5-sonnet-20241022'],
  haiku: ['anthropic/claude-haiku-4-5-20251001', 'anthropic/claude-3-5-haiku-20241022'],
  gpt: ['openai/gpt-4.1', 'openai/gpt-4o'],
  gemini: ['google/gemini-2.5-pro'],
  flash: ['google/gemini-2.5-flash'],
  gemma: ['ollama/gemma3'],
  llama: ['ollama/llama3.2'],
  qwen: ['ollama/qwen2.5-coder'],
};

/**
 * A `ModelProvider` that pins one already-resolved model.
 *
 * `AgentLoop` takes a `ModelProvider`, and `ModelRouter` is not one -- it has no
 * `id`, `listModels`, or `isAvailable`. Rather than widen the loop, the CLI
 * resolves the model once and hands the loop a provider that always uses it, so
 * the alias is resolved before the run starts instead of on every step.
 */
export function pinned(resolved: ResolvedModel): ModelProvider {
  const { provider, info } = resolved;
  return {
    id: provider.id,
    displayName: provider.displayName,
    priority: provider.priority,
    isAvailable: () => provider.isAvailable(),
    listModels: async () => [info],
    chat: (req: ChatRequest): Promise<ChatResponse> => provider.chat({ ...req, model: info.name }),
    stream: (req: ChatRequest): AsyncIterable<StreamEvent> => provider.stream({ ...req, model: info.name }),
  };
}
