import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSpec, parseSpec } from '@husk/core';
import { parseSpecYaml, readSpec, stringifySpec, writeSpec } from './serialize.js';

const SPEC = parseSpec({
  name: 'release-bot',
  displayName: 'Release Bot',
  description: 'Cuts releases for this repo.',
  model: 'opus',
  persona: 'You are the release engineer.\n\n- Always run the tests.\n- Never force-push to main.',
  knowledge: [{ title: 'Topology', content: 'api: fly.io iad\nworker: box-3', source: 'transcript' }],
  examples: [{ user: 'cut 1.2.4', assistant: 'Tagging v1.2.4 once the suite is green.' }],
  tools: ['computer', 'files'],
  computer: { enabled: true, flavor: 'node' },
  triggers: [{ type: 'cron', schedule: '0 9 * * 1', prompt: 'weekly release check' }],
  origin: { source: '/p/s.jsonl', transcriptId: 's1', importedAt: '2026-09-09T00:00:00.000Z', messageCount: 941 },
});

describe('stringifySpec', () => {
  const yaml = stringifySpec(SPEC);

  it('opens with a header naming the source transcript', () => {
    expect(yaml.startsWith('#')).toBe(true);
    expect(yaml).toContain('# Distilled from: /p/s.jsonl');
    expect(yaml).toContain('# Messages read: 941');
  });

  it('orders keys identity, model, persona, knowledge, examples, tools, computer, limits, guardrails, triggers', () => {
    const keys = yaml
      .split('\n')
      .map((l) => /^([a-zA-Z][\w]*):/.exec(l)?.[1])
      .filter((k): k is string => !!k);
    const expected = [
      'apiVersion',
      'name',
      'displayName',
      'version',
      'description',
      'model',
      'fallbackModels',
      'persona',
      'knowledge',
      'examples',
      'tools',
      'computer',
      'limits',
      'guardrails',
      'memory',
      'triggers',
      'metadata',
      'origin',
    ];
    expect(keys).toEqual(expected);
  });

  it('uses a block scalar for multi-line strings', () => {
    expect(yaml).toMatch(/^persona: \|/m);
    expect(yaml).toContain('  You are the release engineer.');
    // Not a folded one-liner.
    expect(yaml).not.toContain('persona: "You are');
  });

  it('emits no anchors or aliases', () => {
    expect(yaml).not.toMatch(/(^|\s)[&*]\w/);
  });

  it('can be asked for no header', () => {
    expect(stringifySpec(SPEC, { header: null }).startsWith('apiVersion:')).toBe(true);
  });

  it('accepts a caller-supplied source label', () => {
    expect(stringifySpec(SPEC, { sourceLabel: 'my chat export' })).toContain('# Distilled from: my chat export');
  });
});

describe('round trip', () => {
  it('is lossless for a fully populated spec', () => {
    expect(parseSpecYaml(stringifySpec(SPEC))).toEqual(SPEC);
  });

  it('is lossless for a minimal spec', () => {
    const minimal = defaultSpec('tiny');
    expect(parseSpecYaml(stringifySpec(minimal))).toEqual(minimal);
  });

  it('preserves awkward strings exactly', () => {
    const tricky = parseSpec({
      name: 'tricky',
      persona: 'line one: with a colon\n  indented\n\nblank line above\ttab\n- looks like a list',
      description: '# not a comment, "quoted", and a trailing space ',
      knowledge: [{ title: 'yes: no', content: '```sh\necho "hi"\n```\n' }],
    });
    expect(parseSpecYaml(stringifySpec(tricky))).toEqual(tricky);
  });

  it('survives two passes unchanged', () => {
    const once = stringifySpec(SPEC);
    expect(stringifySpec(parseSpecYaml(once))).toBe(once);
  });
});

describe('readSpec / writeSpec', () => {
  it('writes then reads the same spec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'husk-sessions-'));
    const file = join(dir, 'nested', 'husk.yaml');
    const written = await writeSpec(file, SPEC);
    expect(await readFile(file, 'utf8')).toBe(written);
    expect(await readSpec(file)).toEqual(SPEC);
  });

  it('reports a missing file as an actionable HuskError', async () => {
    await expect(readSpec(join(tmpdir(), 'husk-does-not-exist-9f2', 'husk.yaml'))).rejects.toMatchObject({
      code: 'E_SPEC_INVALID',
    });
  });
});

describe('parseSpecYaml', () => {
  it('rejects broken YAML with the parser message attached', () => {
    expect(() => parseSpecYaml('name: [unclosed', 'x.yaml')).toThrowError(/x\.yaml is not valid YAML/);
  });

  it('rejects an empty document', () => {
    expect(() => parseSpecYaml('\n')).toThrowError(/is empty/);
  });

  it('rejects a document the schema does not accept', () => {
    expect(() => parseSpecYaml('name: Not A Slug')).toThrowError(/lowercase alphanumeric/);
  });
});
