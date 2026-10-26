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
vi.mock('@husk-ai/models', async (original) => ({ ...(await original<object>()), defaultProviders: () => [ollama] }));
const { resolveModel } = await import('./models.js');

describe('resolveModel', () => {
  it('finds a pulled model under its :latest tag, by alias or by name', async () => {
    expect((await resolveModel('llama')).info.id).toBe('ollama/llama3.2:latest');
    expect((await resolveModel('qwen')).info.id).toBe('ollama/qwen2.5-coder:latest');
    expect((await resolveModel('gemma')).info.id).toBe('ollama/gemma3:latest');
    expect((await resolveModel('ollama/llama3.2:latest')).info.id).toBe('ollama/llama3.2:latest');
    expect((await resolveModel('mistral-nemo:12b')).info.id).toBe('ollama/mistral-nemo:12b');
  });
});
