/**
 * The alias table from docs/BUILD-CONTRACT.md, plus whatever the user pinned in
 * `~/.husk/config.json`.
 *
 * Three aliases cannot be resolved from a table because their answer depends on what
 * is running on the machine right now: `local`, `free` and `auto`. Those resolve to a
 * strategy the router executes against `detect()`.
 */

import { HuskError } from '@husk/core';
import { CATALOG, findByBareName, findModel, splitModelId } from './catalog.js';

/** Aliases that resolve to a fixed, fully-qualified model id. */
export const STATIC_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  opus: 'anthropic/claude-opus-5',
  sonnet: 'anthropic/claude-sonnet-5',
  haiku: 'anthropic/claude-haiku-4-5-20251001',
  gpt: 'openai/gpt-4.1',
  gemini: 'google/gemini-2.5-pro',
  flash: 'google/gemini-2.5-flash',
  gemma: 'ollama/gemma3',
  llama: 'ollama/llama3.2',
  qwen: 'ollama/qwen2.5-coder',
});

export type DynamicStrategy = 'local' | 'free' | 'auto';

/** Aliases whose answer is "whatever is actually reachable", resolved by the router. */
export const DYNAMIC_ALIASES: Readonly<Record<string, DynamicStrategy>> = Object.freeze({
  local: 'local',
  free: 'free',
  auto: 'auto',
});

export type AliasResolution =
  | { kind: 'model'; id: string; provider: string; name: string; via?: string }
  | { kind: 'dynamic'; strategy: DynamicStrategy; via: string };

export function isAlias(name: string): boolean {
  return name in STATIC_ALIASES || name in DYNAMIC_ALIASES;
}

/**
 * Turn anything a user might type into either a fully-qualified `provider/model` or a
 * strategy for the router to run.
 *
 * Accepted, in order: a user override, a canonical alias, an explicit
 * `provider/model`, or a bare model name that exactly one provider in the catalog
 * offers. User overrides may themselves point at another alias; cycles throw rather
 * than hang.
 */
export function resolveAlias(input: string, overrides: Record<string, string> = {}): AliasResolution {
  const original = input.trim();
  if (!original) {
    throw new HuskError('E_CONFIG', 'No model requested', {
      hint: 'Pass a model alias such as `sonnet`, `qwen`, or `auto`.',
    });
  }

  const seen = new Set<string>();
  let current = original;

  for (let hop = 0; hop < 8; hop++) {
    if (seen.has(current)) {
      throw new HuskError('E_CONFIG', `Model alias "${original}" loops back on itself`, {
        hint: `Fix the modelAliases entry for "${current}" in ~/.husk/config.json.`,
        details: { chain: [...seen] },
      });
    }
    seen.add(current);

    const override = overrides[current];
    if (override && override !== current) {
      current = override.trim();
      continue;
    }

    const strategy = DYNAMIC_ALIASES[current];
    if (strategy) return { kind: 'dynamic', strategy, via: original };

    const canonical = STATIC_ALIASES[current];
    if (canonical) {
      current = canonical;
      continue;
    }

    const split = splitModelId(current);
    if (split) {
      return {
        kind: 'model',
        id: current,
        provider: split.provider,
        name: split.name,
        ...(current === original ? {} : { via: original }),
      };
    }

    const bare = findByBareName(current);
    if (bare) {
      return {
        kind: 'model',
        id: bare.id,
        provider: bare.provider,
        name: bare.name,
        ...(current === original ? {} : { via: original }),
      };
    }

    throw new HuskError('E_MODEL_UNAVAILABLE', `Unknown model "${original}"`, {
      hint: `Use provider/model, or one of: ${knownAliases().join(', ')}.`,
      details: { input: original, resolvedTo: current },
    });
  }

  throw new HuskError('E_CONFIG', `Model alias "${original}" is nested too deeply`, {
    hint: 'Point the alias straight at a provider/model id.',
  });
}

export function knownAliases(): string[] {
  return [...Object.keys(STATIC_ALIASES), ...Object.keys(DYNAMIC_ALIASES)];
}

/** The alias table as `husk models --aliases` should print it. */
export function aliasTable(overrides: Record<string, string> = {}): Array<{
  alias: string;
  target: string;
  source: 'canonical' | 'dynamic' | 'user';
}> {
  const rows: Array<{ alias: string; target: string; source: 'canonical' | 'dynamic' | 'user' }> = [];
  for (const [alias, target] of Object.entries(STATIC_ALIASES)) {
    const override = overrides[alias];
    rows.push(
      override
        ? { alias, target: override, source: 'user' }
        : { alias, target, source: 'canonical' },
    );
  }
  for (const alias of Object.keys(DYNAMIC_ALIASES)) {
    const override = overrides[alias];
    rows.push(
      override
        ? { alias, target: override, source: 'user' }
        : { alias, target: describeStrategy(alias as DynamicStrategy), source: 'dynamic' },
    );
  }
  for (const [alias, target] of Object.entries(overrides)) {
    if (!isAlias(alias)) rows.push({ alias, target, source: 'user' });
  }
  return rows;
}

function describeStrategy(s: DynamicStrategy): string {
  if (s === 'local') return 'first available Ollama model';
  if (s === 'free') return 'best free model that is actually reachable';
  return 'best available, preferring quality then cost';
}

/** Every alias whose canonical target is missing from the catalog. Used by a test. */
export function danglingAliases(): string[] {
  return Object.entries(STATIC_ALIASES)
    .filter(([, id]) => !findModel(id))
    .map(([alias, id]) => `${alias} -> ${id}`);
}

export function catalogIds(): string[] {
  return CATALOG.map((m) => m.id);
}
