import type { ModelInfo, ModelProvider } from '@husk-ai/core';
import { describe, expect, it, vi } from 'vitest';

/** Ollama as it answers: each pulled model under its tag, `:latest` included. */
const pulled = ['llama3.2:latest', 'qwen2.5-coder:latest', 'gemma3:latest', 'mistral-nemo:12b'];
const ollama = {
  id: 'ollama',
  displayName: 'Ollama',
  priority: 1,
  isAvailable: async () => ({ available: true }),
  listModels: async () => pulled.map((name) => ({ id: `ollama/${name}`, provider: 'ollama', name }) as ModelInfo),
} as unknown as ModelProvider;
/** A free tier the catalog still prices, ranked ahead of Ollama as `husk run` ranks providers. */
const google = {
  id: 'google',
  displayName: 'Google',
  priority: 5,
  isAvailable: async () => ({ available: true }),
  listModels: async () => [
    { id: 'google/gemini-2.5-flash', provider: 'google', name: 'gemini-2.5-flash', free: true, pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 } } as ModelInfo,
  ],
} as unknown as ModelProvider;
let providers = [ollama];
vi.mock('@husk-ai/models', async (original) => ({ ...(await original<object>()), defaultProviders: () => providers }));
const { resolveModel } = await import('./models.js');

describe('resolveModel', () => {
  it('finds a pulled model under its :latest tag, by alias or by name', async () => {
    expect((await resolveModel('llama')).info.id).toBe('ollama/llama3.2:latest');
    expect((await resolveModel('qwen')).info.id).toBe('ollama/qwen2.5-coder:latest');
    expect((await resolveModel('gemma')).info.id).toBe('ollama/gemma3:latest');
    expect((await resolveModel('ollama/llama3.2:latest')).info.id).toBe('ollama/llama3.2:latest');
    expect((await resolveModel('mistral-nemo:12b')).info.id).toBe('ollama/mistral-nemo:12b');
  });

  it('picks a model that costs nothing for free and auto under a $0 ceiling, which a free tier does not', async () => {
    providers = [google, ollama];
    try {
      expect((await resolveModel('free')).info.id).toBe('google/gemini-2.5-flash');
      expect((await resolveModel('free', {}, 0)).info.provider).toBe('ollama');
      expect((await resolveModel('auto', {}, 0)).info.provider).toBe('ollama');
      providers = [google];
      await expect(resolveModel('free', {}, 0)).rejects.toMatchObject({ code: 'E_BUDGET_EXCEEDED' });
    } finally {
      providers = [ollama];
    }
  });
});
