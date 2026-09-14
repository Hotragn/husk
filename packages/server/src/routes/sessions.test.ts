import type { HuskSpec } from '@husk/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../testing.js';
import type { TestApp } from '../testing.js';

/**
 * `POST /v1/sessions/distill` maps through `@husk/sessions.toSpec`.
 *
 * The route used to carry its own copy of the mapping, which wrote
 * `metadata.distillConfidence` / `metadata.distillNotes` while the CLI and
 * `@husk/sessions` wrote `metadata.distilledConfidence` / `distillerNotes`.
 * The keys are documented, so the server's spelling meant a husk imported over
 * HTTP had provenance nothing would read.
 */
const MARKDOWN = [
  '# chat',
  '',
  '## User',
  'Always run the migration before the model change, and never deploy on a Friday.',
  '',
  '## Assistant',
  'Understood. I will run the migration first.',
  '',
].join('\n');

describe('POST /v1/sessions/distill', () => {
  let harness: TestApp;
  let spec: HuskSpec;

  beforeAll(async () => {
    harness = await buildTestApp();
    const imported = await harness.app.inject({
      method: 'POST',
      url: '/v1/sessions/import',
      payload: { content: MARKDOWN, source: 'markdown' },
    });
    expect(imported.statusCode).toBe(200);
    const transcriptId = (imported.json() as { transcript: { id: string } }).transcript.id;

    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/sessions/distill',
      payload: { transcriptId },
    });
    expect(res.statusCode).toBe(200);
    spec = (res.json() as { spec: HuskSpec }).spec;
  }, 30_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it('writes the documented metadata keys', () => {
    expect(typeof spec.metadata.distilledConfidence).toBe('number');
    expect(Array.isArray(spec.metadata.distillerNotes)).toBe(true);
  });

  it('does not write the server-only spellings any more', () => {
    expect(spec.metadata).not.toHaveProperty('distillConfidence');
    expect(spec.metadata).not.toHaveProperty('distillNotes');
  });

  it('records provenance the same way the CLI does', () => {
    expect(spec.origin?.transcriptId).toBeTruthy();
    expect(spec.origin?.messageCount).toBeGreaterThan(0);
    expect(spec.origin?.importedAt).toBeTruthy();
  });

  it('emits only tool bundles the agent can resolve', () => {
    for (const tool of spec.tools) expect(['computer', 'files', 'web', 'http']).toContain(tool);
    expect(spec.tools.length).toBeGreaterThan(0);
  });
});
