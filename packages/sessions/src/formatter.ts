import type { DistilledAgent, Transcript } from '@husk/core';
import { toSpec } from './distill.js';
import { stringifySpec } from './serialize.js';

/**
 * Kept because callers import it. It is now a thin wrapper over `toSpec` +
 * `stringifySpec`, so its output is guaranteed to parse -- the hand-rolled
 * string builder this replaced could emit YAML that `parseSpec` rejected.
 */
export function toHuskYaml(agent: DistilledAgent, transcript?: Transcript): string {
  return stringifySpec(toSpec(agent, transcript ? { transcript } : {}));
}
