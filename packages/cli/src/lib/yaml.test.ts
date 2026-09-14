import { describe, expect, it } from 'vitest';
import { defaultSpec, parseSpec } from '@husk-ai/core';
import type { DistilledAgent } from '@husk-ai/core';
import { renderSpec, slugName, specFromDistilled } from './yaml.js';
import { parseYaml } from './yaml.js';

async function roundTrip(spec: ReturnType<typeof defaultSpec>) {
  return parseSpec(await parseYaml(renderSpec(spec)));
}

describe('renderSpec', () => {
  it('produces YAML its own parser accepts', async () => {
    const spec = defaultSpec('round-trip');
    const back = await roundTrip(spec);
    expect(back.name).toBe('round-trip');
    expect(back.persona).toBe(spec.persona);
  });

  it('omits fields that match the schema default, so a diff shows real choices', () => {
    const yaml = renderSpec(defaultSpec('minimal'));
    expect(yaml).not.toContain('maxSteps');
    expect(yaml).not.toContain('redactSecrets');
    expect(yaml).toContain('name: minimal');
  });

  it('writes a changed field and keeps it after a round trip', async () => {
    const spec = parseSpec({ ...defaultSpec('tuned'), limits: { maxSteps: 99 } });
    expect(renderSpec(spec)).toContain('maxSteps: 99');
    expect((await roundTrip(spec)).limits.maxSteps).toBe(99);
  });

  it('uses a block scalar for a multi-line persona, so it stays reviewable', async () => {
    const spec = parseSpec({ ...defaultSpec('multi'), persona: 'line one\nline two\nline three' });
    expect(renderSpec(spec)).toContain('persona: |');
    expect((await roundTrip(spec)).persona).toBe('line one\nline two\nline three');
  });

  it('quotes a value YAML would otherwise read as a boolean', async () => {
    const spec = parseSpec({ ...defaultSpec('q'), description: 'yes' });
    expect((await roundTrip(spec)).description).toBe('yes');
  });

  it('survives colons, quotes and hashes in prose', async () => {
    const nasty = 'Rule: always say "hello" # and never leave';
    const spec = parseSpec({ ...defaultSpec('nasty'), persona: nasty });
    expect((await roundTrip(spec)).persona).toBe(nasty);
  });

  it('writes provenance as comments above the document', async () => {
    const yaml = renderSpec(defaultSpec('p'), { provenance: ['from a chat', 'confidence 0.4'] });
    expect(yaml.startsWith('# from a chat\n# confidence 0.4\n')).toBe(true);
    expect(parseSpec(await parseYaml(yaml)).name).toBe('p');
  });

  it('round-trips knowledge and examples', async () => {
    const spec = parseSpec({
      ...defaultSpec('rich'),
      knowledge: [{ title: 'Policy', content: 'Never refund.\nEscalate instead.' }],
      examples: [{ user: 'hi', assistant: 'Hello.\nHow can I help?' }],
    });
    const back = await roundTrip(spec);
    expect(back.knowledge[0]?.content).toBe('Never refund.\nEscalate instead.');
    expect(back.examples[0]?.assistant).toBe('Hello.\nHow can I help?');
  });
});

describe('slugName', () => {
  it.each([
    ['Support Triage Bot', 'support-triage-bot'],
    ['CSV → JSON helper', 'csv-json-helper'],
    ['  spaced  out  ', 'spaced-out'],
    ['Already-Fine', 'already-fine'],
  ])('turns %s into %s', (input, expected) => {
    expect(slugName(input)).toBe(expected);
  });

  it('produces something the schema accepts even from junk', () => {
    for (const junk of ['', '???', '---', '123', '-leading']) {
      expect(slugName(junk)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});

describe('specFromDistilled', () => {
  const base: DistilledAgent = {
    name: 'Support Triage Bot',
    description: 'Triages support tickets.',
    persona: 'Be terse.',
    knowledge: [],
    examples: [],
    suggestedTools: [],
    needsComputer: false,
    confidence: 0.4,
    notes: ['thin signal'],
  };

  it('slugs a free-form name into something the schema accepts', () => {
    // The distiller emits prose; HuskSpecSchema wants ^[a-z0-9][a-z0-9-]*$.
    // Without this step `husk distill` would write a file `husk validate` rejects.
    expect(specFromDistilled(base).name).toBe('support-triage-bot');
    expect(specFromDistilled(base).displayName).toBe('Support Triage Bot');
  });

  it('maps invented tool names onto real bundles', () => {
    expect(specFromDistilled({ ...base, suggestedTools: ['bash', 'Read', 'WebFetch'] }).tools.sort()).toEqual([
      'computer',
      'files',
      'web',
    ]);
  });

  it('drops tool names that match nothing rather than writing an unknown tool', () => {
    expect(specFromDistilled({ ...base, suggestedTools: ['telepathy'] }).tools).toEqual(['files']);
  });

  it('always adds the computer bundle when the agent needs a machine', () => {
    const spec = specFromDistilled({ ...base, needsComputer: true, suggestedTools: [] });
    expect(spec.tools).toContain('computer');
    expect(spec.computer.enabled).toBe(true);
  });

  it('records confidence and notes in metadata, so a reviewer sees them', () => {
    const spec = specFromDistilled(base);
    expect(spec.metadata.distilledConfidence).toBe(0.4);
    expect(spec.metadata.distillerNotes).toEqual(['thin signal']);
  });

  it('lets an explicit --name win over the distilled one', () => {
    expect(specFromDistilled(base, { name: 'my-bot' }).name).toBe('my-bot');
  });

  it('clamps an over-long description instead of failing validation', () => {
    const spec = specFromDistilled({ ...base, description: 'x'.repeat(500) });
    expect(spec.description.length).toBeLessThanOrEqual(280);
  });

  it('never produces a spec parseSpec would reject', () => {
    const hostile: DistilledAgent = {
      ...base,
      name: '!!!',
      persona: '',
      description: 'y'.repeat(400),
      suggestedTools: ['', '  ', 'nonsense'],
    };
    expect(() => parseSpec(specFromDistilled(hostile))).not.toThrow();
  });
});
