/**
 * OpenAI: the base dialect plus the quirks only OpenAI's own models have.
 *
 * The reasoning families (`o1`, `o3`, `o4`, `gpt-5`) rename `max_tokens`, reject a
 * `temperature` other than 1, and take a `reasoning_effort` instead of a thinking
 * budget. Sending the wrong one is a 400, which is the one error class the router
 * will not retry, so getting this right here is the difference between a working
 * request and a dead one.
 */

import type { ChatRequest } from '@husk/core';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
  type ProviderOptions,
} from './openai-compatible.js';

const CONFIG: OpenAICompatibleConfig = {
  id: 'openai',
  displayName: 'OpenAI',
  priority: 85,
  baseUrl: 'https://api.openai.com/v1',
  envKey: 'OPENAI_API_KEY',
  hostEnvKey: 'OPENAI_BASE_URL',
  hint: 'Set OPENAI_API_KEY, or run `ollama pull qwen2.5:7b` for a free local model that can call tools.',
};

/** Model families that use the reasoning-era parameter names. */
function isReasoningModel(model: string): boolean {
  return /^(o[1-9]|gpt-5)/.test(model);
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(opts: ProviderOptions = {}) {
    super(CONFIG, opts);
  }

  protected override tuneBody(body: Record<string, unknown>, req: ChatRequest): Record<string, unknown> {
    const model = String(body['model'] ?? '');
    if (!isReasoningModel(model)) return body;

    if (body['max_tokens'] !== undefined) {
      body['max_completion_tokens'] = body['max_tokens'];
      delete body['max_tokens'];
    }
    // The reasoning models accept only the default sampling settings.
    delete body['temperature'];
    delete body['top_p'];

    if (req.thinking?.enabled) body['reasoning_effort'] = effortFor(req.thinking.budgetTokens);
    return body;
  }
}

/**
 * OpenAI takes an effort level, not a token budget. Map the budget onto the three
 * buckets rather than pretend we can express it exactly.
 */
function effortFor(budgetTokens: number | undefined): 'low' | 'medium' | 'high' {
  if (budgetTokens === undefined) return 'medium';
  if (budgetTokens <= 2_048) return 'low';
  if (budgetTokens >= 16_384) return 'high';
  return 'medium';
}
