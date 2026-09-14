import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HuskError, ensurePaths, id as newId, paths } from '@husk-ai/core';
import type { Transcript, TranscriptImporter, TranscriptSource } from '@husk-ai/core';

/** Importers, loaded lazily -- `@husk-ai/sessions` is not on the fast path. */
export async function importers(): Promise<TranscriptImporter[]> {
  const m = await import('@husk-ai/sessions');
  const built: TranscriptImporter[] = [];
  for (const Ctor of [m.ClaudeCodeImporter, m.ChatGPTImporter, m.CursorImporter, m.GeminiImporter, m.MarkdownImporter, m.UniversalImporter]) {
    if (typeof Ctor === 'function') built.push(new Ctor() as TranscriptImporter);
  }
  return built;
}

/**
 * Pick an importer by sniffing, and say why when nothing matches.
 *
 * Every importer reports a 0..1 confidence and must not throw, so the loser of a
 * detection race is still useful information -- the error lists what each one
 * scored, which turns "import failed" into something a user can act on.
 */
export async function parseTranscripts(input: {
  path?: string;
  content?: string;
  source?: TranscriptSource;
}): Promise<Transcript[]> {
  const all = await importers();

  if (input.source) {
    const chosen = all.find((i) => i.id === input.source);
    if (!chosen) {
      throw new HuskError('E_IMPORT_FAILED', `no importer for source "${input.source}"`, {
        hint: `known sources: ${all.map((i) => i.id).join(', ')}`,
      });
    }
    return withOrigin(await chosen.parse(input), input.path, chosen.id);
  }

  const content = input.content ?? (input.path ? await readFile(input.path, 'utf8').catch(() => undefined) : undefined);
  const scored: Array<{ importer: TranscriptImporter; score: number }> = [];
  for (const importer of all) {
    const score = await importer.detect({ path: input.path, content }).catch(() => 0);
    scored.push({ importer, score });
  }
  scored.sort((a, b) => b.score - a.score);

  for (const { importer, score } of scored) {
    if (score <= 0) break;
    const parsed = await importer.parse(input).catch(() => [] as Transcript[]);
    if (parsed.length) return withOrigin(parsed, input.path, importer.id);
  }

  throw new HuskError('E_IMPORT_FAILED', `nothing in ${input.path ?? 'that input'} looked like a chat transcript`, {
    hint: `force a format with --source: ${all.map((i) => i.id).join(', ')}`,
    details: { scores: Object.fromEntries(scored.map((s) => [s.importer.id, s.score])) },
  });
}

function withOrigin(list: Transcript[], path: string | undefined, source: TranscriptSource): Transcript[] {
  return list.map((t) => ({
    ...t,
    id: t.id || newId('tr'),
    source: t.source || source,
    ...(path && !t.origin ? { origin: path } : {}),
  }));
}

/** Cache an imported transcript so `husk distill <id>` can find it later. */
export async function save(transcript: Transcript): Promise<string> {
  const p = ensurePaths();
  const file = join(p.transcripts, `${transcript.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(transcript, null, 2), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
  return file;
}

export async function load(id: string): Promise<Transcript | null> {
  const file = join(paths().transcripts, `${id}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Transcript;
  } catch {
    return null;
  }
}

export async function listSaved(): Promise<Transcript[]> {
  const dir = paths().transcripts;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: Transcript[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readFile(join(dir, f), 'utf8')) as Transcript);
    } catch {
      // A corrupt cache entry is dropped, not fatal.
    }
  }
  return out;
}

export function summarise(t: Transcript): { user: number; assistant: number; tool: number; chars: number } {
  let user = 0;
  let assistant = 0;
  let tool = 0;
  let chars = 0;
  for (const m of t.messages) {
    chars += m.content?.length ?? 0;
    if (m.role === 'user') user++;
    else if (m.role === 'assistant') assistant++;
    else if (m.role === 'tool') tool++;
  }
  return { user, assistant, tool, chars };
}
