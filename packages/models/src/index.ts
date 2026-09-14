/**
 * @husk/models — one model surface over every provider Husk speaks to.
 *
 * The public entry point is `ModelRouter`. Everything else here is exported because
 * `husk doctor`, `husk models` and the agent loop need to introspect the catalog, the
 * alias table and the token math without reaching into `src/`.
 *
 * This file re-exports. It declares nothing.
 */

export {
  ModelRouter,
  defaultProviders,
  type Candidate,
  type DetectReport,
  type ModelRouterOptions,
  type ModelWarning,
  type ModelWarningEvent,
  type ProviderStatus,
  type RouterRequest,
  type RouterStreamEvent,
} from './router.js';

export {
  DYNAMIC_ALIASES,
  STATIC_ALIASES,
  aliasTable,
  catalogIds,
  danglingAliases,
  isAlias,
  knownAliases,
  resolveAlias,
  type AliasResolution,
  type DynamicStrategy,
} from './aliases.js';

export {
  CATALOG,
  catalogFor,
  findByBareName,
  findModel,
  splitModelId,
  unknownModel,
  type CatalogModel,
} from './catalog.js';

export {
  breakdown,
  costOf,
  formatUsd,
  maximumCostUsd,
  minimumCostUsd,
  priceOf,
  type CostBreakdown,
} from './cost.js';

export {
  danglingToolCalls,
  estimateMessage,
  estimateMessages,
  estimateParts,
  estimateTools,
  fitContext,
  orphanedToolResults,
  type FitOptions,
  type FitResult,
} from './tokens.js';

export {
  ToolCallAccumulator,
  bytes,
  parseJSON,
  readLines,
  readNDJSON,
  readSSE,
  type ByteSource,
  type SSEFrame,
} from './wire.js';

export {
  httpError,
  isAbort,
  isFatalRequestError,
  isRetryable,
  isRetryableStatus,
  networkError,
  scrub,
  statusOf,
  type ErrorContext,
} from './http.js';

export { AnthropicProvider } from './providers/anthropic.js';
export { GoogleProvider } from './providers/google.js';
export { OllamaProvider } from './providers/ollama.js';
export { OpenAIProvider } from './providers/openai.js';
export {
  OpenAICompatibleProvider,
  bareName,
  toOpenAIMessages,
  type FetchLike,
  type OpenAICompatibleConfig,
  type ProviderOptions,
} from './providers/openai-compatible.js';
export {
  COMPATIBLE_CONFIGS,
  CerebrasProvider,
  DeepSeekProvider,
  GroqProvider,
  LMStudioProvider,
  MistralProvider,
  OpenRouterProvider,
  TogetherProvider,
  compatibleProviders,
  type CompatibleProviderId,
} from './providers/compatible.js';
