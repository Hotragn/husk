import { HuskError } from '@husk-ai/core';
import { compareModelPreference, priceOf, resolveAlias } from '@husk-ai/models';
import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider, StreamEvent } from '@husk-ai/core';

/**
 * Every model provider `@husk-ai/models` implements.
 *
 * Taken from the package's own `defaultProviders()` rather than a list kept
 * here, so a provider added upstream appears in `husk doctor` and `husk models`
 * without a second edit -- and so this command can never report a provider as
 * missing when it actually exists.
 */
export async function buildProviders(): Promise<ModelProvider[]> {
  const m = await import('@husk-ai/models');
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
 *
 * `maxCostUsd` is the run's ceiling. At $0, `auto`, `free` and `local` pick only a
 * model that costs nothing, as the router's aliases do: a priced one would be
 * stopped before its first call.
 */
export async function resolveModel(asked: string, overrides: Record<string, string> = {}, maxCostUsd?: number): Promise<ResolvedModel> {
  // A modelAliases entry from ~/.husk/config.json, followed as the router follows it.
  const override = overrides[asked] ? resolveAlias(asked, overrides) : undefined;
  const ref = !override ? asked : override.kind === 'dynamic' ? override.strategy : override.id;
  const providers = await buildProviders();
  const reachable: Array<{ provider: ModelProvider; models: ModelInfo[] }> = [];
  const rejected: string[] = [];

  for (const p of providers) {
    const a = await p.isAvailable().catch((e: Error) => ({ available: false, reason: e.message }));
    if (!a.available) {
      rejected.push(`${p.id}: ${a.reason ?? 'unavailable'}`);
      continue;
    }
    reachable.push({ provider: p, models: (await p.listModels().catch(() => [])).sort(compareModelPreference) });
  }

  if (!reachable.length) {
    throw new HuskError('E_MODEL_UNAVAILABLE', 'no model provider is reachable', {
      hint: 'set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run `ollama serve` for a free local model',
      details: { rejected },
    });
  }

  const wanted = ALIASES[ref] ?? [ref];

  // Ollama lists `llama3.2:latest`, and `llama3.2` is that model: the `llama`,
  // `qwen` and `gemma` aliases name it so, and never matched.
  const plain = (s: string) => s.replace(/:latest$/, '');
  for (const candidate of wanted.map(plain)) {
    const [maybeProvider, ...restParts] = candidate.split('/');
    const bare = restParts.join('/');

    for (const { provider, models } of reachable) {
      if (bare && provider.id !== maybeProvider) continue;
      const target = bare || candidate;
      const hit =
        models.find((m) => plain(m.id) === candidate) ??
        models.find((m) => plain(m.name) === target) ??
        models.find((m) => plain(m.id).endsWith(`/${target}`));
      if (hit) return { provider, info: hit };
    }
  }

  const dynamic = ref === 'auto' || ref === 'free' || ref === 'local';
  if (dynamic) {
    // A free tier is still priced in the catalog, so `free` alone would pick it.
    const costsNothing = (m: ModelInfo) => priceOf(m).input === 0 && priceOf(m).output === 0;
    const preferred = ref === 'local' ? reachable.filter((r) => r.provider.id === 'ollama' || r.provider.id === 'lmstudio') : reachable;
    for (const { provider, models } of preferred) {
      const pool = maxCostUsd === 0 ? models.filter(costsNothing) : models;
      const chosen = ref === 'free' ? (pool.find((m) => m.free) ?? (maxCostUsd === 0 ? pool[0] : undefined)) : pool[0];
      if (chosen) return { provider, info: chosen };
    }
    if (maxCostUsd === 0) {
      throw new HuskError('E_BUDGET_EXCEEDED', `no reachable ${ref} model costs nothing, and the ceiling is $0`, {
        hint: 'Raise maxCostUsd, or run `ollama pull qwen2.5:7b` for a model that costs nothing.',
        details: { maxCostUsd, rejected },
      });
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
