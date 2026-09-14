import { basename, extname, join } from 'node:path';
import { mapLimit } from '@husk-ai/core';
import type { ImportInput, Transcript, TranscriptImporter, TranscriptSource } from '@husk-ai/core';
import { ClaudeCodeImporter, parseClaudeJsonl } from './claude.js';
import { ChatGPTImporter } from './chatgpt.js';
import { CursorImporter } from './cursor.js';
import { GeminiImporter } from './gemini.js';
import { MarkdownImporter } from './markdown.js';
import { UniversalImporter } from './universal.js';
import { DEFAULT_WINDOW, listDirs, listFiles, readHeadTail, wholeLines } from './fsutil.js';

export * from './claude.js';
export * from './chatgpt.js';
export * from './cursor.js';
export * from './gemini.js';
export * from './markdown.js';
export * from './universal.js';
export * from './fsutil.js';

/** Every importer that works without a model, in no particular order. */
export function builtinImporters(): TranscriptImporter[] {
  return [
    new ClaudeCodeImporter(),
    new ChatGPTImporter(),
    new CursorImporter(),
    new GeminiImporter(),
    new MarkdownImporter(),
  ];
}

export interface DetectResult {
  importer: TranscriptImporter;
  confidence: number;
}

/** Score every importer against the input. Never throws; a thrown detect scores 0. */
export async function detectAll(
  input: { path?: string; content?: string },
  importers: TranscriptImporter[] = builtinImporters(),
): Promise<DetectResult[]> {
  const scored = await Promise.all(
    importers.map(async (importer) => {
      try {
        const confidence = await importer.detect(input);
        return { importer, confidence: Number.isFinite(confidence) ? confidence : 0 };
      } catch {
        return { importer, confidence: 0 };
      }
    }),
  );
  return scored.sort((a, b) => b.confidence - a.confidence);
}

export interface DetectAndParseResult {
  transcripts: Transcript[];
  source: TranscriptSource;
  confidence: number;
  /** Every importer that scored above zero, best first. Useful in a picker. */
  candidates: Array<{ source: TranscriptSource; confidence: number }>;
}

/**
 * Work out what a file is and read it.
 *
 * `source` on the input short-circuits detection. Otherwise every importer is
 * scored in parallel and tried best-first, because a confident detect can still
 * find zero messages -- a `.jsonl` that turns out to be a log, say.
 */
export async function detectAndParse(
  input: ImportInput,
  importers: TranscriptImporter[] = builtinImporters(),
): Promise<DetectAndParseResult> {
  if (input.source) {
    const forced = importers.find((i) => i.id === input.source);
    if (forced) {
      return {
        transcripts: await forced.parse(input),
        source: forced.id,
        confidence: 1,
        candidates: [{ source: forced.id, confidence: 1 }],
      };
    }
  }

  // Detection wants content. Read a window rather than the whole file when we
  // only have a path, so sniffing an 80 MB transcript stays cheap.
  let probe = input.content;
  if (probe === undefined && input.path) {
    try {
      const ht = await readHeadTail(input.path, 32 * 1024);
      probe = ht.head;
    } catch {
      probe = undefined;
    }
  }

  const detectInput: { path?: string; content?: string } = {
    ...(input.path ? { path: input.path } : {}),
    ...(probe !== undefined ? { content: probe } : {}),
  };
  const scored = await detectAll(detectInput, importers);
  const candidates = scored
    .filter((s) => s.confidence > 0)
    .map((s) => ({ source: s.importer.id, confidence: s.confidence }));

  for (const { importer, confidence } of scored) {
    if (confidence <= 0) continue;
    try {
      const transcripts = await importer.parse(input);
      if (transcripts.some((t) => t.messages.length > 0)) {
        return { transcripts, source: importer.id, confidence, candidates };
      }
    } catch {
      // Try the next importer. A confident-but-wrong guess is common.
    }
  }
  return { transcripts: [], source: 'unknown', confidence: 0, candidates };
}

export interface DiscoveredTranscript {
  id: string;
  source: TranscriptSource;
  title: string;
  messageCount: number;
  updatedAt: string;
  origin: string;
  /** true when messageCount was extrapolated from a head/tail sample. */
  approximate?: boolean;
  bytes?: number;
}

export interface DiscoverOptions {
  /** Restrict to these sources. Default: claude-code, chatgpt, gemini, cursor. */
  sources?: TranscriptSource[];
  /** Skip anything with fewer messages than this. Default 2. */
  minMessages?: number;
  /** Cap the result set. Newest first, so a cap keeps the useful ones. */
  limit?: number;
  concurrency?: number;
  /** Extra directories to scan on top of each importer's defaults. */
  extraLocations?: string[];
}

const TITLE_RE = /"(?:customTitle|aiTitle|summary)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const TIMESTAMP_RE = /"timestamp"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function lastMatch(text: string, re: RegExp): string | undefined {
  re.lastIndex = 0;
  let out: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out = m[1];
  if (out === undefined) return undefined;
  try {
    return JSON.parse(`"${out}"`) as string;
  } catch {
    return out;
  }
}

/**
 * Summarise a Claude JSONL from its first and last 96 KB.
 *
 * Exact when the file fits in the window. Otherwise the message count is a
 * density extrapolation and `approximate` says so -- a picker may not lie about
 * a number it did not count.
 */
async function summariseClaudeFile(path: string): Promise<DiscoveredTranscript | undefined> {
  let ht = await readHeadTail(path, DEFAULT_WINDOW);
  if (ht.size === 0) return undefined;

  let headLines = wholeLines(ht.head, false, !ht.complete);
  if (!headLines.length && !ht.complete) {
    // A single line longer than the window. Widen once, then give up on exactness.
    ht = await readHeadTail(path, 1024 * 1024);
    headLines = wholeLines(ht.head, false, !ht.complete);
  }
  const tailLines = ht.complete ? [] : wholeLines(ht.tail, true, false);

  if (ht.complete) {
    const parsed = parseClaudeJsonl(ht.head, path);
    if (!parsed) return undefined;
    const t = parsed.transcript;
    return {
      id: t.id,
      source: 'claude-code',
      title: t.title ?? basename(path, extname(path)),
      messageCount: t.messages.length,
      updatedAt: t.updatedAt ?? ht.mtime.toISOString(),
      origin: path,
      bytes: ht.size,
    };
  }

  const sample = [...headLines, ...tailLines];
  let bearing = 0;
  let sampledBytes = 0;
  let sessionId: string | undefined;
  for (const line of sample) {
    sampledBytes += Buffer.byteLength(line, 'utf8') + 1;
    try {
      const obj: unknown = JSON.parse(line);
      if (typeof obj !== 'object' || obj === null) continue;
      const rec = obj as Record<string, unknown>;
      if (typeof rec.sessionId === 'string') sessionId ??= rec.sessionId;
      if ((rec.type === 'user' || rec.type === 'assistant') && rec.message) bearing++;
    } catch {
      // Partial line at a window edge.
    }
  }
  const density = sampledBytes > 0 ? bearing / sampledBytes : 0;
  const estimate = Math.max(bearing, Math.round(density * ht.size));

  const window = ht.head + '\n' + ht.tail;
  return {
    id: sessionId ?? basename(path, extname(path)),
    source: 'claude-code',
    title: lastMatch(window, TITLE_RE) ?? basename(path, extname(path)),
    messageCount: estimate,
    updatedAt: lastMatch(ht.tail, TIMESTAMP_RE) ?? ht.mtime.toISOString(),
    origin: path,
    approximate: true,
    bytes: ht.size,
  };
}

async function summariseGenericJson(
  path: string,
  source: TranscriptSource,
): Promise<DiscoveredTranscript | undefined> {
  const ht = await readHeadTail(path, DEFAULT_WINDOW);
  if (ht.size === 0) return undefined;
  const window = ht.head + ht.tail;
  const titleMatch = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(window);
  // Counting turns needs the whole document; the picker gets a marker instead.
  return {
    id: basename(path, extname(path)),
    source,
    title: titleMatch?.[1] ?? basename(path),
    messageCount: 0,
    updatedAt: ht.mtime.toISOString(),
    origin: path,
    approximate: true,
    bytes: ht.size,
  };
}

/**
 * Everything importable on this machine, newest first.
 *
 * Stats and two window reads per file. It does not open a transcript to count
 * its messages, because there are thousands of them and the picker has to paint
 * before the user gets bored.
 */
export async function discover(opts: DiscoverOptions = {}): Promise<DiscoveredTranscript[]> {
  const sources = new Set<TranscriptSource>(
    opts.sources ?? ['claude-code', 'chatgpt', 'gemini', 'cursor'],
  );
  const minMessages = opts.minMessages ?? 2;
  const concurrency = opts.concurrency ?? 24;

  const jobs: Array<{ path: string; source: TranscriptSource }> = [];

  if (sources.has('claude-code')) {
    const claude = new ClaudeCodeImporter();
    for (const root of [...claude.defaultLocations(), ...(opts.extraLocations ?? [])]) {
      for (const dir of await listDirs(root)) {
        for (const f of await listFiles(dir, '.jsonl')) jobs.push({ path: f, source: 'claude-code' });
      }
      for (const f of await listFiles(root, '.jsonl')) jobs.push({ path: f, source: 'claude-code' });
    }
  }

  if (sources.has('chatgpt')) {
    for (const root of new ChatGPTImporter().defaultLocations()) {
      for (const f of await listFiles(root, 'conversations.json')) jobs.push({ path: f, source: 'chatgpt' });
    }
  }

  if (sources.has('gemini')) {
    for (const root of new GeminiImporter().defaultLocations()) {
      for (const dir of [root, ...(await listDirs(root))]) {
        for (const f of await listFiles(join(dir, 'chats'), '.json')) jobs.push({ path: f, source: 'gemini' });
        for (const f of await listFiles(dir, '.json')) jobs.push({ path: f, source: 'gemini' });
      }
    }
  }

  if (sources.has('cursor')) {
    for (const root of new CursorImporter().defaultLocations()) {
      for (const f of await listFiles(root, '.vscdb')) jobs.push({ path: f, source: 'cursor' });
    }
  }

  const results = await mapLimit(jobs, concurrency, async (job) => {
    try {
      return job.source === 'claude-code'
        ? await summariseClaudeFile(job.path)
        : await summariseGenericJson(job.path, job.source);
    } catch {
      return undefined;
    }
  });

  const out = results
    .filter((r): r is DiscoveredTranscript => r !== undefined)
    .filter((r) => r.messageCount >= minMessages || r.source !== 'claude-code')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return opts.limit ? out.slice(0, opts.limit) : out;
}

export { UniversalImporter as ModelAssistedImporter };
