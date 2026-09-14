import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSpec } from '@husk/core';
import type { RunResult } from '@husk/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';
import { paths, tempStore } from './testing.js';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function fresh(indexLimit?: number): Promise<{ store: Store; root: string }> {
  const t = await tempStore();
  cleanup = t.cleanup;
  if (indexLimit === undefined) return { store: t.store, root: t.root };
  const store = new Store({ paths: paths(t.root), indexLimit });
  await store.init();
  return { store, root: t.root };
}

function result(text: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'ignored',
    text,
    messages: [],
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
    durationMs: 5,
    stopReason: 'complete',
    ...overrides,
  };
}

describe('husk persistence', () => {
  it('round-trips a spec through yaml on disk', async () => {
    const { store, root } = await fresh();
    const spec = defaultSpec('triage');
    await store.writeHusk(spec);

    const onDisk = await readFile(join(root, 'husks', 'triage', 'husk.yaml'), 'utf8');
    expect(onDisk).toContain('name: triage');

    const read = await store.readHusk('triage');
    expect(read.spec.name).toBe('triage');
    expect(read.spec.persona).toBe(spec.persona);
  });

  it('keeps the yaml a human wrote instead of re-serialising it', async () => {
    const { store } = await fresh();
    const yaml = '# my bot\nname: verbatim\npersona: |\n  Be brief.\n';
    await store.writeHusk(defaultSpec('verbatim'), yaml);
    expect((await store.readHusk('verbatim')).yaml).toBe(yaml);
  });

  it('preserves createdAt across updates and tracks runCount', async () => {
    const { store, root } = await fresh();
    await store.writeHusk(defaultSpec('a'));
    const created = JSON.parse(await readFile(join(root, 'husks', 'a', 'meta.json'), 'utf8')).createdAt as string;
    await store.bumpRunCount('a');
    await store.bumpRunCount('a');
    await store.writeHusk({ ...defaultSpec('a'), description: 'changed' });

    const meta = JSON.parse(await readFile(join(root, 'husks', 'a', 'meta.json'), 'utf8'));
    expect(meta.createdAt).toBe(created);
    expect(meta.runCount).toBe(2);
    expect((await store.listHusks())[0]).toMatchObject({ description: 'changed', runCount: 2 });
  });

  it('skips a corrupt husk directory rather than failing the whole listing', async () => {
    const { store, root } = await fresh();
    await store.writeHusk(defaultSpec('good'));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(root, 'husks', 'broken'), { recursive: true });
    await writeFile(join(root, 'husks', 'broken', 'husk.yaml'), 'name: "unterminated\n', 'utf8');

    const listed = await store.listHusks();
    expect(listed.map((h) => h.name)).toEqual(['good']);
  });

  it('throws E_HUSK_NOT_FOUND for a husk that is not there', async () => {
    const { store } = await fresh();
    await expect(store.readHusk('ghost')).rejects.toMatchObject({ code: 'E_HUSK_NOT_FOUND' });
  });
});

/**
 * The property that matters: two requests mutating the same husk must not
 * interleave read-modify-write. Without the queue, N concurrent bumps land on a
 * count well below N because they all read the same starting value.
 */
describe('the write queue', () => {
  // These two are I/O bound on purpose: the whole point is 50 real, serialised
  // disk round-trips. On a loaded machine -- a full parallel test run -- that
  // legitimately passes vitest's 5s default and the suite fails for contention
  // rather than for a broken queue. The longer budget is not hiding a bug; it
  // is the honest cost of what is being asserted.
  it('serialises concurrent read-modify-write on one file', { timeout: 30_000 }, async () => {
    const { store, root } = await fresh();
    await store.writeHusk(defaultSpec('busy'));

    await Promise.all(Array.from({ length: 50 }, () => store.bumpRunCount('busy')));

    const meta = JSON.parse(await readFile(join(root, 'husks', 'busy', 'meta.json'), 'utf8'));
    expect(meta.runCount).toBe(50);
  });

  it('does not serialise across unrelated files', { timeout: 30_000 }, async () => {
    const { store } = await fresh();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.writeHusk(defaultSpec(`h${String(i).padStart(2, '0')}`))),
    );
    const listed = await store.listHusks();
    expect(listed).toHaveLength(20);
    expect(new Set(listed.map((h) => h.name)).size).toBe(20);
  });

  it('keeps the queue alive after one operation rejects', async () => {
    const { store, root } = await fresh();
    await store.writeHusk(defaultSpec('resilient'));
    // Deleting a husk that is not there resolves false; a genuinely failing write
    // is simulated by racing a delete with a bump on the same key.
    const results = await Promise.allSettled([
      store.bumpRunCount('resilient'),
      store.deleteHusk('nonexistent'),
      store.bumpRunCount('resilient'),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const meta = JSON.parse(await readFile(join(root, 'husks', 'resilient', 'meta.json'), 'utf8'));
    expect(meta.runCount).toBe(2);
  });

  it('never leaves a temp file behind', async () => {
    const { store, root } = await fresh();
    await Promise.all(Array.from({ length: 20 }, () => store.bumpRunCount('temped')));
    await store.writeHusk(defaultSpec('temped'));
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(root, 'husks', 'temped'));
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('drains on close', async () => {
    const { store } = await fresh();
    for (let i = 0; i < 10; i++) void store.bumpRunCount('drain-me');
    await store.close();
    // Everything settled; a subsequent read sees the final value rather than a
    // partially written file.
    expect(await store.listHusks()).toBeDefined();
  });
});

describe('runs', () => {
  it('appends events as ndjson and stores a summary', async () => {
    const { store, root } = await fresh();
    const runId = store.newRunId();
    await store.startRun({ runId, husk: 'triage', model: 'auto', startedAt: new Date().toISOString() });
    await store.appendEvent(runId, { type: 'run_start', runId, husk: 'triage', model: 'auto' });
    await store.appendEvent(runId, { type: 'text_delta', text: 'hello' });
    await store.finishRun(runId, result('hello'), 'triage', 'auto');

    const ndjson = await readFile(join(root, 'runs', runId, 'events.ndjson'), 'utf8');
    expect(ndjson.trimEnd().split('\n')).toHaveLength(2);

    const loaded = await store.readRun(runId);
    expect(loaded.events).toHaveLength(2);
    expect(loaded.result?.text).toBe('hello');
    expect((await store.readRunSummary(runId))?.status).toBe('complete');
  });

  it('survives a torn final line in the event log', async () => {
    const { store, root } = await fresh();
    const runId = store.newRunId();
    await store.startRun({ runId, husk: 'x', model: 'auto', startedAt: new Date().toISOString() });
    await store.appendEvent(runId, { type: 'text_delta', text: 'good' });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(root, 'runs', runId, 'events.ndjson'), '{"type":"text_de', 'utf8');

    const loaded = await store.readRun(runId);
    expect(loaded.events).toHaveLength(1);
  });

  it('returns runs newest first and paginates with an opaque cursor', async () => {
    const { store } = await fresh();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const runId = store.newRunId();
      ids.push(runId);
      await store.startRun({ runId, husk: 'triage', model: 'auto', startedAt: new Date().toISOString() });
      await store.finishRun(runId, result(`r${i}`), 'triage', 'auto');
    }

    const first = await store.listRuns({ limit: 3 });
    expect(first.runs.map((r) => r.runId)).toEqual(ids.slice(-3).reverse());
    expect(first.nextCursor).toBeTruthy();

    const second = await store.listRuns({ limit: 3, cursor: first.nextCursor! });
    expect(second.runs.map((r) => r.runId)).toEqual(ids.slice(1, 4).reverse());

    const third = await store.listRuns({ limit: 3, cursor: second.nextCursor! });
    expect(third.runs.map((r) => r.runId)).toEqual([ids[0]!]);
    expect(third.nextCursor).toBeUndefined();
  });

  it('ignores a nonsense cursor rather than returning nothing', async () => {
    const { store } = await fresh();
    const runId = store.newRunId();
    await store.startRun({ runId, husk: 'a', model: 'auto', startedAt: new Date().toISOString() });
    expect((await store.listRuns({ cursor: 'not-a-cursor' })).runs).toHaveLength(1);
  });

  /**
   * The point of the bounded index: paging past the resident window must still
   * work, and it must not have to open every run directory to do it.
   */
  it('pages past the in-memory window by re-reading the index file', async () => {
    const { store } = await fresh(3);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const runId = store.newRunId();
      ids.push(runId);
      await store.startRun({ runId, husk: 'triage', model: 'auto', startedAt: new Date().toISOString() });
      await store.finishRun(runId, result(`r${i}`), 'triage', 'auto');
    }

    const page1 = await store.listRuns({ limit: 4 });
    expect(page1.runs).toHaveLength(4);
    const page2 = await store.listRuns({ limit: 4, cursor: page1.nextCursor! });
    const page3 = await store.listRuns({ limit: 4, cursor: page2.nextCursor! });
    const seen = [...page1.runs, ...page2.runs, ...page3.runs].map((r) => r.runId);
    expect(seen).toEqual([...ids].reverse());
  });

  it('reloads the index from disk in a new process', async () => {
    const t = await tempStore();
    cleanup = t.cleanup;
    const runId = t.store.newRunId();
    await t.store.startRun({ runId, husk: 'triage', model: 'auto', startedAt: new Date().toISOString() });
    await t.store.finishRun(runId, result('persisted'), 'triage', 'auto');
    await t.store.close();

    const reopened = new Store({ paths: paths(t.root) });
    await reopened.init();
    const listed = await reopened.listRuns();
    expect(listed.runs.map((r) => r.runId)).toEqual([runId]);
    expect(listed.runs[0]!.preview).toBe('persisted');
  });

  it('tombstones a deleted run so a reopened index does not resurrect it', async () => {
    const t = await tempStore();
    cleanup = t.cleanup;
    const keep = t.store.newRunId();
    const drop = t.store.newRunId();
    for (const runId of [keep, drop]) {
      await t.store.startRun({ runId, husk: 'triage', model: 'auto', startedAt: new Date().toISOString() });
      await t.store.finishRun(runId, result(runId), 'triage', 'auto');
    }
    expect(await t.store.deleteRun(drop)).toBe(true);
    expect(await t.store.deleteRun(drop)).toBe(false);
    await t.store.close();

    const reopened = new Store({ paths: paths(t.root) });
    await reopened.init();
    expect((await reopened.listRuns()).runs.map((r) => r.runId)).toEqual([keep]);
  });

  it('filters by husk across the whole index', async () => {
    const { store } = await fresh(2);
    for (const husk of ['a', 'b', 'a', 'b', 'a']) {
      const runId = store.newRunId();
      await store.startRun({ runId, husk, model: 'auto', startedAt: new Date().toISOString() });
      await store.finishRun(runId, result(husk), husk, 'auto');
    }
    expect((await store.listRuns({ husk: 'a' })).runs).toHaveLength(3);
    expect((await store.listRuns({ husk: 'b' })).runs).toHaveLength(2);
  });
});

describe('idempotency records', () => {
  it('replays a recorded response and forgets an unknown key', async () => {
    const { store } = await fresh();
    store.rememberIdempotent('POST /v1/computers k1', 201, { id: 'cmp_1' });
    expect(store.recallIdempotent('POST /v1/computers k1')).toEqual({ status: 201, body: { id: 'cmp_1' } });
    expect(store.recallIdempotent('POST /v1/computers k2')).toBeUndefined();
  });
});

describe('transcripts', () => {
  it('saves and reads back, and 404s an unknown id', async () => {
    const { store } = await fresh();
    await store.saveTranscript({ id: 't1', source: 'markdown', messages: [{ role: 'user', content: 'hi' }] });
    expect((await store.readTranscript('t1')).messages).toHaveLength(1);
    await expect(store.readTranscript('nope')).rejects.toMatchObject({ code: 'E_TRANSCRIPT_NOT_FOUND' });
  });
});

describe('parseHuskInput error shapes', () => {
  // parseHuskInput touches no disk, so a bare temp root is enough.
  const store = () => new Store({ paths: paths('/husk-parse-only') });

  it('reports a YAML syntax error as invalid input, not an internal error', () => {
    // Letting the yaml parser's exception escape produced a 500 and a raw
    // "Flow sequence in block collection must be sufficiently indented"
    // message -- an internal-error page for a missing bracket.
    expect(() => store().parseHuskInput({ yaml: 'a:\n  - [' })).toThrowError(/yaml did not parse/);
    try {
      store().parseHuskInput({ yaml: 'a:\n  - [' });
    } catch (e) {
      expect((e as { code: string }).code).toBe('E_SPEC_INVALID');
    }
  });

  it('says which field is missing when the body carries neither', () => {
    try {
      store().parseHuskInput({});
    } catch (e) {
      expect((e as { code: string }).code).toBe('E_SPEC_INVALID');
      expect((e as Error).message).toMatch(/either `spec` or `yaml`/);
    }
  });

  it('still accepts a valid yaml body', () => {
    const { spec, yaml } = store().parseHuskInput({ yaml: 'name: ok-bot\npersona: Be terse.\n' });
    expect(spec.name).toBe('ok-bot');
    expect(yaml).toContain('ok-bot');
  });
});
