import type { ModelInfo } from '@husk-ai/core';
import { findModel } from './catalog.js';

/**
 * Stable default ordering, never used to override an explicit model choice.
 * Capability comes first. For uncatalogued local models, prefer an installed
 * model in the 7B+ tier over a tiny model, then the smaller sufficient model:
 * parameter count is a practical default, not a benchmark or a RAM estimate.
 */
export function compareModelPreference(a: ModelInfo, b: ModelInfo): number {
  const capability = Number(b.supportsTools) - Number(a.supportsTools);
  if (capability) return capability;
  const quality = (model: ModelInfo): number =>
    (model as ModelInfo & { quality?: number }).quality ?? findModel(model.id)?.quality ?? (model.free === true ? 40 : 50);
  const score = quality(b) - quality(a);
  if (score) return score;
  // Compare metadata availability before size, so mixed known/unknown counts
  // cannot make the comparator cyclic as context windows break ties.
  const knownSize = Number(Boolean(b.parameterCount)) - Number(Boolean(a.parameterCount));
  if (knownSize) return knownSize;
  if (a.parameterCount && b.parameterCount) {
    const tier = (n: number): number => n >= 7_000_000_000 ? 2 : n >= 3_000_000_000 ? 1 : 0;
    const byTier = tier(b.parameterCount) - tier(a.parameterCount);
    if (byTier) return byTier;
    if (a.parameterCount !== b.parameterCount) return a.parameterCount - b.parameterCount;
  }
  return b.contextWindow - a.contextWindow || a.id.localeCompare(b.id);
}
