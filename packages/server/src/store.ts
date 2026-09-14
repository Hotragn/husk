import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { ensurePaths, paths, parseSpec, safeParseSpec, tid } from '@husk-ai/core';
import type { HuskPaths, HuskSpec, RunEvent, RunResult, Transcript } from '@husk-ai/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { notFound } from './errors.js';
import { huskError } from './errors.js';

export interface HuskSummary {
  name: string;
  displayName: string;
  description: string;
  model: string;
  version: string;
  tools: string[];
  triggers: string[];
  computer: { enabled: boolean; flavor: string };
  updatedAt: string;
  runCount: number;
}

export interface RunSummary {
  runId: string;
  husk: string;
  model: string;
  status: 'running' | 'complete' | 'step_limit' | 'budget' | 'timeout' | 'aborted' | 'loop' | 'error';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  steps?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  preview?: string;
  error?: { message: string; code?: string };
}

/** Index rows carry a monotonic sequence so pagination cursors stay opaque and stable. */
interface IndexRow extends RunSummary {
  seq: number;
  /** Append-only means deletes are tombstones, not rewrites. */
  deleted?: boolean;
}

export interface StoreOptions {
  paths?: HuskPaths;
  /** How many run summaries stay resident. Older pages fall back to the index file. */
  indexLimit?: number;
}

/**
 * Every write goes through here.
 *
 * Two properties matter and neither is free. Durability: a crash halfway through a
 * write must leave the previous version intact, so full-file writes are
 * write-then-rename. Serialisation: two concurrent HTTP requests mutating the same
 * husk must not interleave read-modify-write, so every path gets a promise chain and
 * operations on it queue behind each other.
 */
class WriteQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // `fn` runs on both settlement paths: one caller's failure must not strand the
    // next caller's write behind a rejected promise forever.
    const result = prev.then(fn, fn);
    const guarded: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, guarded);
    void guarded.then(() => {
      if (this.chains.get(key) === guarded) this.chains.delete(key);
    });
    return result;
  }

  get depth(): number {
    return this.chains.size;
  }

  /** Resolves once every queued write has settled. Used by graceful shutdown. */
  async drain(): Promise<void> {
    for (let i = 0; i < 1000 && this.chains.size > 0; i++) {
      await Promise.allSettled([...this.chains.values()]);
      await new Promise((r) => setImmediate(r));
    }
  }
}

async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export class Store {
  readonly paths: HuskPaths;
  private readonly queue = new WriteQueue();
  private readonly indexLimit: number;
  /** Newest-first, bounded. The hot page of `GET /v1/runs` never touches the disk. */
  private index: IndexRow[] = [];
  private seq = 0;
  private loaded = false;
  /** True once a row has aged out of memory, so paging knows the disk holds more. */
  private truncated = false;

  constructor(opts: StoreOptions = {}) {
    this.paths = opts.paths ?? paths();
    this.indexLimit = opts.indexLimit ?? 500;
  }

  async init(): Promise<void> {
    ensurePaths(this.paths);
    await this.loadIndex();
  }

  // -- husks ---------------------------------------------------------------

  private huskDir(name: string): string {
    return join(this.paths.husks, name);
  }

  private huskYamlFile(name: string): string {
    return join(this.huskDir(name), 'husk.yaml');
  }

  private huskMetaFile(name: string): string {
    return join(this.huskDir(name), 'meta.json');
  }

  async listHusks(): Promise<HuskSummary[]> {
    let names: string[];
    try {
      names = (await readdir(this.paths.husks, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
    const out: HuskSummary[] = [];
    for (const name of names) {
      const loaded = await this.tryReadHusk(name);
      if (loaded) out.push(await this.summarise(loaded.spec, name));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async tryReadHusk(name: string): Promise<{ spec: HuskSpec; yaml: string } | undefined> {
    let yaml: string;
    try {
      yaml = await readFile(this.huskYamlFile(name), 'utf8');
    } catch {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = parseYaml(yaml) as unknown;
    } catch {
      // One hand-edited file with a stray quote must not break `husk ls`.
      return undefined;
    }
    const parsed = safeParseSpec(raw);
    if (!parsed.ok) return undefined;
    return { spec: parsed.spec, yaml };
  }

  async readHusk(name: string): Promise<{ spec: HuskSpec; yaml: string }> {
    const found = await this.tryReadHusk(name);
    if (!found) throw notFound('husk', name);
    return found;
  }

  async writeHusk(spec: HuskSpec, yamlSource?: string): Promise<HuskSummary> {
    const name = spec.name;
    return this.queue.run(this.huskDir(name), async () => {
      await mkdir(this.huskDir(name), { recursive: true });
      const yaml = yamlSource ?? stringifyYaml(spec, { lineWidth: 100 });
      await writeAtomic(this.huskYamlFile(name), yaml);
      const meta = (await readJson<{ createdAt?: string; runCount?: number }>(this.huskMetaFile(name))) ?? {};
      const now = new Date().toISOString();
      await writeAtomic(
        this.huskMetaFile(name),
        JSON.stringify({ createdAt: meta.createdAt ?? now, updatedAt: now, runCount: meta.runCount ?? 0 }, null, 2),
      );
      return this.summarise(spec, name);
    });
  }

  async deleteHusk(name: string): Promise<boolean> {
    return this.queue.run(this.huskDir(name), async () => {
      const exists = await this.tryReadHusk(name);
      if (!exists) return false;
      await rm(this.huskDir(name), { recursive: true, force: true });
      return true;
    });
  }

  async bumpRunCount(name: string): Promise<void> {
    await this.queue.run(this.huskDir(name), async () => {
      const file = this.huskMetaFile(name);
      const meta = (await readJson<{ createdAt?: string; updatedAt?: string; runCount?: number }>(file)) ?? {};
      await writeAtomic(
        file,
        JSON.stringify({ ...meta, runCount: (meta.runCount ?? 0) + 1 }, null, 2),
      );
    });
  }

  private async summarise(spec: HuskSpec, name: string): Promise<HuskSummary> {
    const meta = await readJson<{ updatedAt?: string; runCount?: number }>(this.huskMetaFile(name));
    return {
      name: spec.name,
      displayName: spec.displayName ?? spec.name,
      description: spec.description,
      model: spec.model,
      version: spec.version,
      tools: spec.tools,
      triggers: spec.triggers.map((t) => t.type),
      computer: { enabled: spec.computer.enabled, flavor: spec.computer.flavor },
      updatedAt: meta?.updatedAt ?? new Date(0).toISOString(),
      runCount: meta?.runCount ?? 0,
    };
  }

  /** Accepts either half of the `{ spec } | { yaml }` union API.md allows. */
  /**
   * Turn a request body into a spec.
   *
   * Every failure here is the caller's input being wrong, so every failure is a
   * 4xx. Letting the YAML parser's own exception escape produced a 500 and a
   * raw "Flow sequence in block collection must be sufficiently indented"
   * message -- an internal-error page for a missing bracket.
   */
  parseHuskInput(body: unknown): { spec: HuskSpec; yaml?: string } {
    const b = (body ?? {}) as { spec?: unknown; yaml?: unknown };

    if (typeof b.yaml === 'string') {
      let parsed: unknown;
      try {
        parsed = parseYaml(b.yaml) as unknown;
      } catch (err) {
        throw huskError('E_SPEC_INVALID', `yaml did not parse: ${(err as Error).message}`, {
          hint: 'check the indentation -- husk.yaml is YAML, and tabs are not valid indentation',
          cause: err,
        });
      }
      return { spec: parseSpec(parsed), yaml: b.yaml };
    }

    if (b.spec === undefined || b.spec === null) {
      throw huskError('E_SPEC_INVALID', 'body must carry either `spec` or `yaml`', {
        hint: 'POST { "yaml": "name: my-bot\npersona: ..." } or { "spec": { ... } }',
      });
    }

    return { spec: parseSpec(b.spec) };
  }

  toYaml(spec: HuskSpec): string {
    return stringifyYaml(spec, { lineWidth: 100 });
  }

  // -- runs ----------------------------------------------------------------

  private runDir(runId: string): string {
    return join(this.paths.runs, runId);
  }

  private indexFile(): string {
    return join(this.paths.runs, 'index.ndjson');
  }

  newRunId(): string {
    return tid('run');
  }

  private async loadIndex(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const rows: IndexRow[] = [];
    try {
      const rl = createInterface({ input: createReadStream(this.indexFile(), 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as IndexRow;
          rows.push(row);
          if (rows.length > this.indexLimit * 4) rows.splice(0, rows.length - this.indexLimit * 2);
        } catch {
          // A torn final line from a hard kill is expected; the rest of the file is good.
        }
      }
    } catch {
      return;
    }
    // The index is append-only, so later rows supersede earlier ones for the same run.
    const latest = new Map<string, IndexRow>();
    for (const row of rows) {
      this.seq = Math.max(this.seq, row.seq);
      if (row.deleted) latest.delete(row.runId);
      else latest.set(row.runId, row);
    }
    const all = [...latest.values()].sort((a, b) => b.seq - a.seq);
    if (all.length > this.indexLimit) this.truncated = true;
    this.index = all.slice(0, this.indexLimit);
  }

  /** Create the run record and its event log. Called before the agent starts. */
  async startRun(summary: Omit<RunSummary, 'status'> & { status?: RunSummary['status'] }): Promise<RunSummary> {
    const record: RunSummary = { ...summary, status: summary.status ?? 'running' };
    await this.queue.run(this.runDir(record.runId), async () => {
      await mkdir(this.runDir(record.runId), { recursive: true });
      await writeAtomic(join(this.runDir(record.runId), 'run.json'), JSON.stringify(record, null, 2));
    });
    await this.appendIndex(record);
    return record;
  }

  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    const file = join(this.runDir(runId), 'events.ndjson');
    await this.queue.run(file, async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(event) + '\n', 'utf8');
    });
  }

  async finishRun(runId: string, result: RunResult, husk: string, model: string): Promise<RunSummary> {
    const existing = await this.readRunSummary(runId);
    const summary: RunSummary = {
      runId,
      husk,
      model,
      status: result.stopReason,
      startedAt: existing?.startedAt ?? new Date(Date.now() - result.durationMs).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      steps: result.steps,
      costUsd: result.usage.costUsd ?? 0,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      preview: result.text.slice(0, 240),
    };
    if (result.error) summary.error = result.error;

    await this.queue.run(this.runDir(runId), async () => {
      await mkdir(this.runDir(runId), { recursive: true });
      await writeAtomic(join(this.runDir(runId), 'run.json'), JSON.stringify(summary, null, 2));
      await writeAtomic(join(this.runDir(runId), 'result.json'), JSON.stringify(result, null, 2));
    });
    await this.appendIndex(summary);
    return summary;
  }

  private async appendIndex(summary: RunSummary, deleted = false): Promise<void> {
    const row: IndexRow = { ...summary, seq: ++this.seq };
    if (deleted) row.deleted = true;
    const merged = deleted
      ? this.index.filter((r) => r.runId !== row.runId)
      : [row, ...this.index.filter((r) => r.runId !== row.runId)];
    if (merged.length > this.indexLimit) this.truncated = true;
    this.index = merged.slice(0, this.indexLimit);
    await this.queue.run(this.indexFile(), async () => {
      await mkdir(this.paths.runs, { recursive: true });
      await appendFile(this.indexFile(), JSON.stringify(row) + '\n', 'utf8');
    });
  }

  async readRunSummary(runId: string): Promise<RunSummary | undefined> {
    const inMemory = this.index.find((r) => r.runId === runId);
    if (inMemory) {
      const { seq: _seq, ...rest } = inMemory;
      return rest;
    }
    return readJson<RunSummary>(join(this.runDir(runId), 'run.json'));
  }

  async readRun(runId: string): Promise<{ result: RunResult | undefined; events: RunEvent[] }> {
    const result = await readJson<RunResult>(join(this.runDir(runId), 'result.json'));
    const events: RunEvent[] = [];
    try {
      const rl = createInterface({
        input: createReadStream(join(this.runDir(runId), 'events.ndjson'), 'utf8'),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as RunEvent);
        } catch {
          // torn line at the tail of a killed process
        }
      }
    } catch {
      // no events yet
    }
    if (!result && events.length === 0) {
      const summary = await this.readRunSummary(runId);
      if (!summary) throw notFound('run', runId);
    }
    return { result, events };
  }

  /**
   * Newest-first page of runs.
   *
   * The first page is served from the bounded in-memory index. Anything older
   * re-reads the single append-only index file rather than stat-ing every run
   * directory, which is what makes this O(runs written) instead of O(runs kept).
   */
  async listRuns(opts: { husk?: string; limit?: number; cursor?: string } = {}): Promise<{
    runs: RunSummary[];
    nextCursor?: string;
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const parsed = opts.cursor ? Number.parseInt(opts.cursor, 36) : Number.NaN;
    const before = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    const match = (r: IndexRow) => !r.deleted && r.seq < before && (!opts.husk || r.husk === opts.husk);

    let rows = this.index.filter(match);
    if (rows.length <= limit && this.truncated) rows = (await this.readIndexFile()).filter(match);
    rows = rows.slice(0, limit + 1);

    const page = rows.slice(0, limit);
    const out: { runs: RunSummary[]; nextCursor?: string } = {
      runs: page.map(({ seq: _seq, ...rest }) => rest),
    };
    if (rows.length > limit && page.length > 0) out.nextCursor = page[page.length - 1]!.seq.toString(36);
    return out;
  }

  private async readIndexFile(): Promise<IndexRow[]> {
    const latest = new Map<string, IndexRow>();
    try {
      const rl = createInterface({ input: createReadStream(this.indexFile(), 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as IndexRow;
          if (row.deleted) latest.delete(row.runId);
          else latest.set(row.runId, row);
        } catch {
          // torn line
        }
      }
    } catch {
      return [];
    }
    return [...latest.values()].sort((a, b) => b.seq - a.seq);
  }

  async deleteRun(runId: string): Promise<boolean> {
    const summary = await this.readRunSummary(runId);
    if (!summary) return false;
    await this.appendIndex(summary, true);
    await this.queue.run(this.runDir(runId), async () => {
      await rm(this.runDir(runId), { recursive: true, force: true });
    });
    return true;
  }

  // -- transcripts ---------------------------------------------------------

  async saveTranscript(t: Transcript): Promise<void> {
    const file = join(this.paths.transcripts, `${t.id}.json`);
    await this.queue.run(file, () => writeAtomic(file, JSON.stringify(t, null, 2)));
  }

  async readTranscript(id: string): Promise<Transcript> {
    const t = await readJson<Transcript>(join(this.paths.transcripts, `${id}.json`));
    if (!t) throw notFound('transcript', id);
    return t;
  }

  // -- idempotency ---------------------------------------------------------

  private readonly idempotency = new Map<string, { at: number; body: unknown; status: number }>();

  rememberIdempotent(key: string, status: number, body: unknown): void {
    this.idempotency.set(key, { at: Date.now(), status, body });
    if (this.idempotency.size > 1000) {
      const cutoff = Date.now() - 15 * 60_000;
      for (const [k, v] of this.idempotency) if (v.at < cutoff) this.idempotency.delete(k);
    }
  }

  recallIdempotent(key: string): { status: number; body: unknown } | undefined {
    const hit = this.idempotency.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > 15 * 60_000) {
      this.idempotency.delete(key);
      return undefined;
    }
    return { status: hit.status, body: hit.body };
  }

  async close(): Promise<void> {
    await this.queue.drain();
  }
}
