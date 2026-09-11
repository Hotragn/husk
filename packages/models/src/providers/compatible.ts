/**
 * Every provider that is "OpenAI, but elsewhere".
 *
 * These are configuration, not code. Each entry is a base URL, an environment
 * variable, and whatever single quirk that gateway has. If you find yourself adding a
 * method here, the quirk belongs in `OpenAICompatibleProvider` behind a config flag,
 * or the provider deserves its own file the way Anthropic and Google do.
 */

import { HUSK_UA } from '../http.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
  type ProviderOptions,
} from './openai-compatible.js';

export const COMPATIBLE_CONFIGS = {
  groq: {
    id: 'groq',
    displayName: 'Groq',
    priority: 60,
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    hint: 'Set GROQ_API_KEY — Groq has a free tier at console.groq.com/keys.',
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    priority: 55,
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    discover: true,
    // OpenRouter attributes traffic by these two headers and shows the title on its
    // activity page; without them a Husk user's calls are filed as anonymous.
    headers: { 'http-referer': 'https://husk.sh', 'x-title': 'Husk', 'user-agent': HUSK_UA },
    freeSuffix: ':free',
    hint: 'Set OPENROUTER_API_KEY — openrouter.ai lists several `:free` models.',
  },
  together: {
    id: 'together',
    displayName: 'Together AI',
    priority: 50,
    baseUrl: 'https://api.together.xyz/v1',
    envKey: 'TOGETHER_API_KEY',
    discover: true,
    hint: 'Set TOGETHER_API_KEY from api.together.ai/settings/api-keys.',
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    priority: 58,
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    hint: 'Set DEEPSEEK_API_KEY from platform.deepseek.com.',
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral',
    priority: 52,
    baseUrl: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    // Mistral's endpoint rejects requests carrying unknown top-level stream options.
    streamUsage: false,
    hint: 'Set MISTRAL_API_KEY from console.mistral.ai.',
  },
  cerebras: {
    id: 'cerebras',
    displayName: 'Cerebras',
    priority: 56,
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'CEREBRAS_API_KEY',
    streamUsage: false,
    hint: 'Set CEREBRAS_API_KEY — cloud.cerebras.ai has a free tier.',
  },
  lmstudio: {
    id: 'lmstudio',
    displayName: 'LM Studio',
    priority: 42,
    baseUrl: 'http://127.0.0.1:1234/v1',
    hostEnvKey: 'LMSTUDIO_HOST',
    discover: true,
    alwaysFree: true,
    streamUsage: false,
    hint: 'Start the LM Studio local server (Developer tab) and load a model.',
  },
} as const satisfies Record<string, OpenAICompatibleConfig>;

export type CompatibleProviderId = keyof typeof COMPATIBLE_CONFIGS;

/**
 * Named subclasses so callers can `new GroqProvider()` and so declaration emit has
 * something to point at. Each one is its config and nothing else — if a body ever
 * appears in here, the behaviour belongs in the base class.
 */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor(opts: ProviderOptions = {}) {
    super(COMPATIBLE_CONFIGS.groq, opts);
  }
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(opts: ProviderOptions = {}) {
    super(COMPATIBLE_CONFIGS.openrouter, opts);
  }
}

export class TogetherProvider extends OpenAICompatibleProvider {
  constructor(opts: ProviderOptions = {}) {
    super(COMPATIBLE_CONFIGS.together, opts);
  }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(opts: ProviderOptions = {}) {
    super(COMPATIBLE_CONFIGS.deepseek, opts);
  }
}

export class MistralProvider extends OpenAICompatibleProvider {
  constructor(opts: ProviderOptions = {}) {
    super(COMPATIBLE_CONFIGS.mistral, opts);
  }
}

export class CerebrasProvider extends OpenAICompatibleProvider {
  constructor(opts: ProviderOptions = {}) {
    super(COMPATIBLE_CONFIGS.cerebras, opts);
  }
}

export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(opts: ProviderOptions = {}) {
    super(COMPATIBLE_CONFIGS.lmstudio, opts);
  }
}

/** One instance of each, for the router's default registry. */
export function compatibleProviders(opts: ProviderOptions = {}): OpenAICompatibleProvider[] {
  return (Object.keys(COMPATIBLE_CONFIGS) as CompatibleProviderId[]).map(
    (id) => new OpenAICompatibleProvider(COMPATIBLE_CONFIGS[id], opts),
  );
}
