import { parseSpec } from '@husk-ai/core';
import type { DistilledAgent, Transcript } from '@husk-ai/core';
import { describe, expect, it } from 'vitest';
import { normaliseTools, toSpec } from './distill.js';
import { parseSpecYaml, stringifySpec } from './serialize.js';

/**
 * One mapper, one set of metadata keys.
 *
 * `@husk-ai/sessions`, `@husk-ai/cli` and `@husk-ai/server` each carried their own
 * `DistilledAgent -> HuskSpec` mapping. Two of them wrote
 * `metadata.distilledConfidence` / `metadata.distillerNotes`; the third wrote
 * `distillConfidence` / `distillNotes`. A husk distilled over HTTP therefore
 * lost its provenance to any reader looking for the documented keys.
 */
const AGENT: DistilledAgent = {
  name: 'Support Triage Bot',
  description: 'Triages support tickets.',
  persona: 'Be terse.',
  knowledge: [],
  examples: [],
  suggestedTools: ['Bash', 'Read'],
  needsComputer: true,
  confidence: 0.42,
  notes: ['thin signal', 'no examples survived'],
};

const TRANSCRIPT: Transcript = {
  id: 't_1',
  source: 'claude-code',
  title: 'a support session',
  origin: '/p/session.jsonl',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ],
};

describe('toSpec provenance', () => {
  it('writes the documented metadata keys and no others', () => {
    const spec = toSpec(AGENT, { transcript: TRANSCRIPT });
    expect(spec.metadata.distilledConfidence).toBe(0.42);
    expect(spec.metadata.distillerNotes).toEqual(['thin signal', 'no examples survived']);
    expect(spec.metadata).not.toHaveProperty('distillConfidence');
    expect(spec.metadata).not.toHaveProperty('distillNotes');
  });

  it('records origin from the transcript', () => {
    const spec = toSpec(AGENT, { transcript: TRANSCRIPT });
    expect(spec.origin).toMatchObject({
      source: '/p/session.jsonl',
      transcriptId: 't_1',
      messageCount: 2,
    });
  });

  it('keeps confidence, notes and origin across a husk.yaml round trip', () => {
    const spec = toSpec(AGENT, { transcript: TRANSCRIPT });
    const reparsed = parseSpecYaml(stringifySpec(spec));

    expect(reparsed.metadata.distilledConfidence).toBe(0.42);
    expect(reparsed.metadata.distillerNotes).toEqual(['thin signal', 'no examples survived']);
    expect(reparsed.origin).toEqual(spec.origin);
    // A round trip through YAML must not quietly rewrite the rest of the spec.
    expect(reparsed).toEqual(spec);
  });

  it('is stable enough that re-mapping the same agent gives the same spec', () => {
    const a = toSpec(AGENT, { transcript: TRANSCRIPT });
    const b = toSpec(AGENT, { transcript: TRANSCRIPT });
    expect({ ...b, origin: a.origin }).toEqual(a);
  });
});

describe('normaliseTools', () => {
  it('maps host tool names onto bundles the agent can resolve', () => {
    expect(normaliseTools(['Bash', 'Read', 'WebFetch'], false).sort()).toEqual(['computer', 'files', 'web']);
  });

  it('passes an explicit bundle name straight through, including http', () => {
    expect(normaliseTools(['http'], false)).toEqual(['http']);
  });

  it('drops names that resolve to nothing rather than writing a dead tool', () => {
    expect(normaliseTools(['telepathy', '', '   '], false)).toEqual(['files']);
  });

  it('adds the computer bundle whenever the agent needs a machine', () => {
    expect(normaliseTools([], true)).toContain('computer');
  });

  it('only ever emits tools a spec accepts', () => {
    const spec = parseSpec({ name: 'x', tools: normaliseTools(['nonsense', 'mcp__x__y'], false) });
    expect(spec.tools).toEqual(['files']);
  });
});
