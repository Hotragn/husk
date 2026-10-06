import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@husk-ai/core';
import { compareModelPreference } from './preference.js';

const local = (name: string, parameterCount: number, supportsTools = true): ModelInfo => ({
  id: `ollama/${name}`, name, provider: 'ollama', displayName: name,
  parameterCount, supportsTools, supportsVision: false, supportsStreaming: true,
  contextWindow: 32768, maxOutputTokens: 8192, free: true,
});

describe('default model preference', () => {
  it('chooses a sufficient tool model regardless of daemon listing order, without choosing the largest', () => {
    const models = [local('tiny', 1_500_000_000), local('huge', 70_000_000_000), local('medium', 7_600_000_000)];
    expect([...models].sort(compareModelPreference).map((m) => m.name)).toEqual(['medium', 'huge', 'tiny']);
    expect([...models].reverse().sort(compareModelPreference)[0]?.name).toBe('medium');
  });

  it('puts confirmed tool support ahead of parameter size', () => {
    expect([local('text-only', 8_000_000_000, false), local('tool-model', 3_000_000_000)].sort(compareModelPreference)[0]?.name).toBe('tool-model');
  });

  it('breaks equal metadata ties deterministically', () => {
    expect([local('z', 7_000_000_000), local('a', 7_000_000_000)].sort(compareModelPreference)[0]?.name).toBe('a');
  });

  it('keeps one ordering across permutations with missing size metadata', () => {
    const a = { ...local('sufficient', 7_000_000_000), contextWindow: 1000 };
    const b = { ...local('unknown', 0), parameterCount: undefined, contextWindow: 2000 };
    const c = { ...local('tiny', 1_500_000_000), contextWindow: 3000 };
    for (const models of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
      expect(models.sort(compareModelPreference).map((m) => m.name)).toEqual(['sufficient', 'tiny', 'unknown']);
    }
  });
});
