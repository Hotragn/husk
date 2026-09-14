/**
 * The static model catalog: what each hosted model can do, and what it costs.
 *
 * ## On the prices in this file
 *
 * Every number here is USD per million tokens. Prices marked `estimatedPricing: true`
 * are **not** published figures we can vouch for — they are conservative estimates
 * derived from the previous generation of the same tier, and they deliberately err
 * high so a budget guard refuses early rather than late. They exist so that
 * `maxCostUsd` has something to work with; they are not a billing source. Anything
 * without the flag is a number we are reasonably confident about, and it is still
 * only as fresh as this file.
 *
 * `husk models --json` prints the flag, so a user can see which is which.
 *
 * Local models (Ollama, LM Studio) are discovered at runtime and merged *over* these
 * entries: what is actually pulled on the machine wins over what we guessed here.
 */

import type { ModelInfo } from '@husk/core';

export interface CatalogModel extends ModelInfo {
  /**
   * Rough capability ordering, 0-100, used only to break ties for the `auto` alias.
   * It is a maintainer's judgement call, not a benchmark score.
   */
  quality: number;
  /** The `pricing` above is a conservative estimate, not a published number. */
  estimatedPricing?: boolean;
}

/**
 * Conservative per-tier estimates, used where we do not have a published price.
 * Each follows the last published price for that tier and rounds nothing down.
 */
const ESTIMATED_ANTHROPIC_OPUS_TIER = { inputPerMTok: 5, outputPerMTok: 25 };
const ESTIMATED_ANTHROPIC_SONNET_TIER = { inputPerMTok: 3, outputPerMTok: 15 };
const ESTIMATED_OPENAI_FRONTIER_TIER = { inputPerMTok: 1.25, outputPerMTok: 10 };
const ESTIMATED_OPENAI_MINI_TIER = { inputPerMTok: 0.25, outputPerMTok: 2 };
const ESTIMATED_DEEPSEEK_CHAT_TIER = { inputPerMTok: 0.27, outputPerMTok: 1.1 };
const ESTIMATED_DEEPSEEK_REASONER_TIER = { inputPerMTok: 0.55, outputPerMTok: 2.19 };
const ESTIMATED_MISTRAL_LARGE_TIER = { inputPerMTok: 2, outputPerMTok: 6 };
const ESTIMATED_MISTRAL_SMALL_TIER = { inputPerMTok: 0.1, outputPerMTok: 0.3 };
const ESTIMATED_CEREBRAS_70B_TIER = { inputPerMTok: 0.85, outputPerMTok: 1.2 };
const ESTIMATED_CEREBRAS_8B_TIER = { inputPerMTok: 0.1, outputPerMTok: 0.1 };
const ESTIMATED_TOGETHER_70B_TIER = { inputPerMTok: 0.88, outputPerMTok: 0.88 };
const ESTIMATED_TOGETHER_32B_TIER = { inputPerMTok: 0.8, outputPerMTok: 0.8 };

/** A model whose price is genuinely zero: it runs on the user's own silicon. */
const FREE_LOCAL = { inputPerMTok: 0, outputPerMTok: 0 };

/**
 * Anthropic is the one provider here that charges to *write* a cache entry: 1.25x the
 * base input rate, against 0.1x to read one back. Both are spelled out per model as
 * explicit per-MTok prices rather than left as a multiplier for the biller to apply,
 * because the write price is not a fixed fraction of input anywhere else.
 */
const ANTHROPIC: CatalogModel[] = [
  {
    id: 'anthropic/claude-opus-5',
    provider: 'anthropic',
    name: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsThinking: true,
    pricing: { ...ESTIMATED_ANTHROPIC_OPUS_TIER, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
    estimatedPricing: true,
    quality: 100,
    tags: ['frontier', 'coding', 'agentic'],
  },
  {
    id: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    name: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsThinking: true,
    pricing: { ...ESTIMATED_ANTHROPIC_SONNET_TIER, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    estimatedPricing: true,
    quality: 94,
    tags: ['balanced', 'coding', 'agentic'],
  },
  {
    id: 'anthropic/claude-haiku-4-5-20251001',
    provider: 'anthropic',
    name: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsThinking: true,
    pricing: {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
    quality: 82,
    tags: ['fast', 'cheap', 'agentic'],
  },
];

const OPENAI: CatalogModel[] = [
  {
    id: 'openai/gpt-4.1',
    provider: 'openai',
    name: 'gpt-4.1',
    displayName: 'GPT-4.1',
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 },
    quality: 88,
    tags: ['long-context', 'coding'],
  },
  {
    id: 'openai/gpt-4.1-mini',
    provider: 'openai',
    name: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6, cacheReadPerMTok: 0.1 },
    quality: 74,
    tags: ['cheap', 'long-context'],
  },
  {
    id: 'openai/gpt-4.1-nano',
    provider: 'openai',
    name: 'gpt-4.1-nano',
    displayName: 'GPT-4.1 nano',
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.025 },
    quality: 60,
    tags: ['cheap', 'fast'],
  },
  {
    id: 'openai/gpt-5',
    provider: 'openai',
    name: 'gpt-5',
    displayName: 'GPT-5',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsThinking: true,
    pricing: ESTIMATED_OPENAI_FRONTIER_TIER,
    estimatedPricing: true,
    quality: 92,
    tags: ['frontier', 'reasoning'],
  },
  {
    id: 'openai/gpt-5-mini',
    provider: 'openai',
    name: 'gpt-5-mini',
    displayName: 'GPT-5 mini',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsThinking: true,
    pricing: ESTIMATED_OPENAI_MINI_TIER,
    estimatedPricing: true,
    quality: 78,
    tags: ['cheap', 'reasoning'],
  },
  {
    id: 'openai/gpt-4o',
    provider: 'openai',
    name: 'gpt-4o',
    displayName: 'GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
    quality: 80,
    tags: ['legacy'],
  },
  {
    id: 'openai/gpt-4o-mini',
    provider: 'openai',
    name: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
    quality: 62,
    tags: ['cheap', 'legacy'],
  },
  {
    id: 'openai/o3',
    provider: 'openai',
    name: 'o3',
    displayName: 'o3',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsThinking: true,
    pricing: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 },
    quality: 86,
    tags: ['reasoning'],
  },
  {
    id: 'openai/o4-mini',
    provider: 'openai',
    name: 'o4-mini',
    displayName: 'o4-mini',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsThinking: true,
    pricing: { inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.275 },
    quality: 76,
    tags: ['reasoning', 'cheap'],
  },
];

const GOOGLE: CatalogModel[] = [
  {
    id: 'google/gemini-2.5-pro',
    provider: 'google',
    name: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsThinking: true,
    // Google prices Pro in two tiers, above and below a 200k-token prompt. ModelInfo
    // has one slot, so this is the <=200k rate; long prompts cost roughly 2x more.
    pricing: { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31 },
    quality: 90,
    tags: ['long-context', 'reasoning', 'tiered-pricing'],
  },
  {
    id: 'google/gemini-2.5-flash',
    provider: 'google',
    name: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsThinking: true,
    pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.075 },
    // Reachable at zero cost on the Gemini API free tier, at a low rate limit.
    free: true,
    quality: 79,
    tags: ['fast', 'free-tier', 'long-context'],
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    provider: 'google',
    name: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash-Lite',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.025 },
    free: true,
    quality: 64,
    tags: ['cheap', 'free-tier'],
  },
];

const GROQ: CatalogModel[] = [
  {
    id: 'groq/llama-3.3-70b-versatile',
    provider: 'groq',
    name: 'llama-3.3-70b-versatile',
    displayName: 'Llama 3.3 70B (Groq)',
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79 },
    free: true,
    quality: 72,
    tags: ['fast', 'free-tier', 'llama'],
  },
  {
    id: 'groq/llama-3.1-8b-instant',
    provider: 'groq',
    name: 'llama-3.1-8b-instant',
    displayName: 'Llama 3.1 8B Instant (Groq)',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: { inputPerMTok: 0.05, outputPerMTok: 0.08 },
    free: true,
    quality: 50,
    tags: ['fast', 'free-tier', 'llama'],
  },
];

const DEEPSEEK: CatalogModel[] = [
  {
    id: 'deepseek/deepseek-chat',
    provider: 'deepseek',
    name: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: ESTIMATED_DEEPSEEK_CHAT_TIER,
    estimatedPricing: true,
    quality: 76,
    tags: ['cheap', 'coding'],
  },
  {
    id: 'deepseek/deepseek-reasoner',
    provider: 'deepseek',
    name: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    contextWindow: 128_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsThinking: true,
    pricing: ESTIMATED_DEEPSEEK_REASONER_TIER,
    estimatedPricing: true,
    quality: 81,
    tags: ['reasoning', 'cheap'],
  },
];

const MISTRAL: CatalogModel[] = [
  {
    id: 'mistral/mistral-large-latest',
    provider: 'mistral',
    name: 'mistral-large-latest',
    displayName: 'Mistral Large',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: ESTIMATED_MISTRAL_LARGE_TIER,
    estimatedPricing: true,
    quality: 70,
    tags: ['eu'],
  },
  {
    id: 'mistral/mistral-small-latest',
    provider: 'mistral',
    name: 'mistral-small-latest',
    displayName: 'Mistral Small',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: ESTIMATED_MISTRAL_SMALL_TIER,
    estimatedPricing: true,
    quality: 56,
    tags: ['cheap', 'eu'],
  },
];

const CEREBRAS: CatalogModel[] = [
  {
    id: 'cerebras/llama-3.3-70b',
    provider: 'cerebras',
    name: 'llama-3.3-70b',
    displayName: 'Llama 3.3 70B (Cerebras)',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: ESTIMATED_CEREBRAS_70B_TIER,
    estimatedPricing: true,
    free: true,
    quality: 71,
    tags: ['fast', 'free-tier', 'llama'],
  },
  {
    id: 'cerebras/llama3.1-8b',
    provider: 'cerebras',
    name: 'llama3.1-8b',
    displayName: 'Llama 3.1 8B (Cerebras)',
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: ESTIMATED_CEREBRAS_8B_TIER,
    estimatedPricing: true,
    free: true,
    quality: 48,
    tags: ['fast', 'free-tier', 'llama'],
  },
];

const TOGETHER: CatalogModel[] = [
  {
    id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo',
    provider: 'together',
    name: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    displayName: 'Llama 3.3 70B Turbo (Together)',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: ESTIMATED_TOGETHER_70B_TIER,
    estimatedPricing: true,
    quality: 70,
    tags: ['llama'],
  },
  {
    id: 'together/Qwen/Qwen2.5-Coder-32B-Instruct',
    provider: 'together',
    name: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    displayName: 'Qwen2.5 Coder 32B (Together)',
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: ESTIMATED_TOGETHER_32B_TIER,
    estimatedPricing: true,
    quality: 63,
    tags: ['qwen', 'coding'],
  },
];

const OPENROUTER: CatalogModel[] = [
  {
    id: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
    provider: 'openrouter',
    name: 'meta-llama/llama-3.3-70b-instruct:free',
    displayName: 'Llama 3.3 70B (OpenRouter free)',
    contextWindow: 65_536,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: FREE_LOCAL,
    free: true,
    quality: 68,
    tags: ['free-tier', 'llama'],
  },
  {
    id: 'openrouter/deepseek/deepseek-chat',
    provider: 'openrouter',
    name: 'deepseek/deepseek-chat',
    displayName: 'DeepSeek Chat (OpenRouter)',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: ESTIMATED_DEEPSEEK_CHAT_TIER,
    estimatedPricing: true,
    quality: 75,
    tags: ['cheap'],
  },
];

/**
 * Local models. These are the defaults the alias table points at; whatever is
 * genuinely pulled on the machine is discovered from `/api/tags` and merged over
 * this list, so an entry here is a suggestion, not a claim that it exists.
 */
const OLLAMA: CatalogModel[] = [
  {
    id: 'ollama/gemma3',
    provider: 'ollama',
    name: 'gemma3',
    displayName: 'Gemma 3 (local)',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    // Gemma 3 ships no tool template in Ollama: the library lists `vision` and
    // nothing else, and `/api/show` agrees. It is a capable chat and vision
    // model and a poor agent, so a husk with tools should refuse it up front
    // rather than burn minutes of local inference and then narrate a failure.
    supportsTools: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: FREE_LOCAL,
    free: true,
    quality: 46,
    tags: ['local', 'gemma', 'no-tools'],
  },
  {
    id: 'ollama/llama3.2',
    provider: 'ollama',
    name: 'llama3.2',
    displayName: 'Llama 3.2 (local)',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: FREE_LOCAL,
    free: true,
    quality: 42,
    tags: ['local', 'llama'],
  },
  {
    id: 'ollama/qwen2.5-coder',
    provider: 'ollama',
    name: 'qwen2.5-coder',
    displayName: 'Qwen2.5 Coder (local)',
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: FREE_LOCAL,
    free: true,
    quality: 45,
    tags: ['local', 'qwen', 'coding'],
  },
];

export const CATALOG: CatalogModel[] = [
  ...ANTHROPIC,
  ...OPENAI,
  ...GOOGLE,
  ...GROQ,
  ...DEEPSEEK,
  ...MISTRAL,
  ...CEREBRAS,
  ...TOGETHER,
  ...OPENROUTER,
  ...OLLAMA,
];

const BY_ID = new Map(CATALOG.map((m) => [m.id, m]));

/** Split `provider/model` at the **first** slash: `together/meta-llama/X` is one model. */
export function splitModelId(id: string): { provider: string; name: string } | undefined {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return undefined;
  return { provider: id.slice(0, slash), name: id.slice(slash + 1) };
}

export function catalogFor(provider: string): CatalogModel[] {
  return CATALOG.filter((m) => m.provider === provider);
}

export function findModel(id: string): CatalogModel | undefined {
  return BY_ID.get(id);
}

/** Resolve a bare model name to a catalog id when exactly one provider offers it. */
export function findByBareName(name: string): CatalogModel | undefined {
  const matches = CATALOG.filter((m) => m.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Best-effort defaults for a model nobody has catalogued, e.g. a fresh Ollama pull. */
export function unknownModel(provider: string, name: string, free: boolean): CatalogModel {
  return {
    id: `${provider}/${name}`,
    provider,
    name,
    displayName: name,
    contextWindow: 8_192,
    maxOutputTokens: 4_096,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    ...(free ? { pricing: FREE_LOCAL, free: true } : {}),
    quality: free ? 40 : 50,
    tags: ['uncatalogued'],
  };
}
