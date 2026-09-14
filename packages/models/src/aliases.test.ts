import { HuskError } from '@husk-ai/core';
import { describe, expect, it } from 'vitest';
import { aliasTable, danglingAliases, knownAliases, resolveAlias } from './aliases.js';
import { CATALOG, splitModelId } from './catalog.js';

describe('the BUILD-CONTRACT alias table', () => {
  const expected: Array<[string, string]> = [
    ['opus', 'anthropic/claude-opus-5'],
    ['sonnet', 'anthropic/claude-sonnet-5'],
    ['haiku', 'anthropic/claude-haiku-4-5-20251001'],
    ['gpt', 'openai/gpt-4.1'],
    ['gemini', 'google/gemini-2.5-pro'],
    ['flash', 'google/gemini-2.5-flash'],
    ['gemma', 'ollama/gemma3'],
    ['llama', 'ollama/llama3.2'],
    ['qwen', 'ollama/qwen2.5-coder'],
  ];

  for (const [alias, id] of expected) {
    it(`${alias} resolves to ${id}`, () => {
      const resolved = resolveAlias(alias);
      expect(resolved).toMatchObject({ kind: 'model', id });
    });
  }

  for (const dynamic of ['local', 'free', 'auto'] as const) {
    it(`${dynamic} is resolved by the router, not the table`, () => {
      expect(resolveAlias(dynamic)).toEqual({ kind: 'dynamic', strategy: dynamic, via: dynamic });
    });
  }

  it('covers every alias the contract lists', () => {
    expect(knownAliases().sort()).toEqual(
      ['auto', 'flash', 'free', 'gemini', 'gemma', 'gpt', 'haiku', 'llama', 'local', 'opus', 'qwen', 'sonnet'].sort(),
    );
  });

  it('points every alias at a model that exists in the catalog', () => {
    expect(danglingAliases()).toEqual([]);
  });
});

describe('the stale Claude ids are gone', () => {
  it('has no Claude 3 model anywhere in the catalog', () => {
    const stale = CATALOG.filter((m) => /claude-3/.test(m.id));
    expect(stale).toEqual([]);
  });

  it('does not resolve sonnet to a 3.x id', () => {
    const resolved = resolveAlias('sonnet');
    expect(resolved.kind).toBe('model');
    expect(resolved.kind === 'model' && resolved.id).not.toMatch(/claude-3/);
  });
});

describe('resolveAlias', () => {
  it('passes a fully-qualified id straight through', () => {
    expect(resolveAlias('groq/llama-3.3-70b-versatile')).toEqual({
      kind: 'model',
      id: 'groq/llama-3.3-70b-versatile',
      provider: 'groq',
      name: 'llama-3.3-70b-versatile',
    });
  });

  it('splits a namespaced model at the first slash only', () => {
    expect(splitModelId('together/meta-llama/Llama-3.3-70B-Instruct-Turbo')).toEqual({
      provider: 'together',
      name: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    });
  });

  it('resolves a bare model name that only one provider offers', () => {
    expect(resolveAlias('gemini-2.5-flash')).toMatchObject({ id: 'google/gemini-2.5-flash' });
  });

  it('lets a user override a canonical alias', () => {
    const resolved = resolveAlias('sonnet', { sonnet: 'groq/llama-3.3-70b-versatile' });
    expect(resolved).toMatchObject({ id: 'groq/llama-3.3-70b-versatile', via: 'sonnet' });
  });

  it('follows a user alias that points at another alias', () => {
    expect(resolveAlias('fast', { fast: 'haiku' })).toMatchObject({
      id: 'anthropic/claude-haiku-4-5-20251001',
      via: 'fast',
    });
  });

  it('lets a user pin the dynamic aliases too', () => {
    expect(resolveAlias('free', { free: 'ollama/gemma3' })).toMatchObject({ id: 'ollama/gemma3' });
  });

  it('refuses a cycle instead of hanging', () => {
    expect(() => resolveAlias('a', { a: 'b', b: 'a' })).toThrowError(HuskError);
    try {
      resolveAlias('a', { a: 'b', b: 'a' });
    } catch (err) {
      expect((err as HuskError).code).toBe('E_CONFIG');
    }
  });

  it('rejects an unknown name with a hint that lists the aliases', () => {
    try {
      resolveAlias('claude-3-opus');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as HuskError).code).toBe('E_MODEL_UNAVAILABLE');
      expect((err as HuskError).hint).toContain('sonnet');
    }
  });

  it('rejects an empty model', () => {
    expect(() => resolveAlias('  ')).toThrowError(/No model requested/);
  });
});

describe('aliasTable', () => {
  it('marks which rows the user changed', () => {
    const rows = aliasTable({ sonnet: 'ollama/gemma3', fast: 'haiku' });
    expect(rows.find((r) => r.alias === 'sonnet')).toEqual({
      alias: 'sonnet',
      target: 'ollama/gemma3',
      source: 'user',
    });
    expect(rows.find((r) => r.alias === 'opus')?.source).toBe('canonical');
    expect(rows.find((r) => r.alias === 'fast')?.source).toBe('user');
  });
});
