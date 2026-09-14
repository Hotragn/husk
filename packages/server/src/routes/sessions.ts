import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { mapLimit, slug } from '@husk-ai/core';
import type { DistilledAgent, HuskSpec, Transcript, TranscriptImporter, TranscriptSource } from '@husk-ai/core';
import type { FastifyInstance } from 'fastify';
import { stringify as stringifyYaml } from 'yaml';
import { ctxOf } from '../context.js';
import { huskError } from '../errors.js';
import { SseStream } from '../sse.js';

/**
 * Where each tool keeps its history.
 *
 * `TranscriptImporter` declares an optional `defaultLocations()` and none of the
 * shipped importers implement it, so discovery cannot delegate. These are the
 * fallbacks; an importer that grows the method overrides them.
 */
const DEFAULT_LOCATIONS: Partial<Record<TranscriptSource, string[]>> = {
  'claude-code': [join(homedir(), '.claude', 'projects'), join(homedir(), '.config', 'claude', 'projects')],
  cursor: [join(homedir(), '.cursor', 'chats')],
  gemini: [join(homedir(), '.gemini', 'sessions')],
};

const DISCOVER_FILE_LIMIT = 200;
const DISCOVER_DEPTH = 3;

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0 || out.length >= DISCOVER_FILE_LIMIT) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= DISCOVER_FILE_LIMIT) return;
    const name = String(entry.name);
    const full = join(dir, name);
    if (entry.isDirectory()) await walk(full, depth - 1, out);
    else if (/\.(jsonl|json|md)$/i.test(name)) out.push(full);
  }
}

interface DiscoveredSession {
  id: string;
  source: TranscriptSource;
  title: string;
  messageCount: number;
  updatedAt: string;
  origin: string;
}

/** Counting lines beats parsing megabytes of JSONL just to populate a list. */
async function peek(file: string, source: TranscriptSource): Promise<DiscoveredSession | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size === 0) return null;

  let messageCount = 0;
  let title = basename(file).replace(/\.(jsonl|json|md)$/i, '');
  if (file.toLowerCase().endsWith('.jsonl')) {
    try {
      const head = await readFile(file, 'utf8');
      const lines = head.split('\n').filter((l) => l.trim().length > 0);
      messageCount = lines.length;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as { summary?: string; title?: string };
          if (typeof obj.summary === 'string') {
            title = obj.summary;
            break;
          }
          if (typeof obj.title === 'string') {
            title = obj.title;
            break;
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }
  }

  return {
    id: slug(`${source}-${basename(file)}`, 64),
    source,
    title,
    messageCount,
    updatedAt: info.mtime.toISOString(),
    origin: file,
  };
}

async function loadImporters(): Promise<Map<TranscriptSource, TranscriptImporter>> {
  const map = new Map<TranscriptSource, TranscriptImporter>();
  try {
    const mod = (await import('@husk-ai/sessions')) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (typeof value !== 'function') continue;
      let instance: unknown;
      try {
        instance = new (value as new () => unknown)();
      } catch {
        continue;
      }
      const candidate = instance as Partial<TranscriptImporter>;
      if (typeof candidate.detect === 'function' && typeof candidate.parse === 'function' && candidate.id) {
        map.set(candidate.id, candidate as TranscriptImporter);
      }
    }
  } catch {
    // @husk-ai/sessions unbuilt: session endpoints degrade, the rest of the server does not.
  }
  return map;
}

async function pickImporter(
  importers: Map<TranscriptSource, TranscriptImporter>,
  input: { path?: string; content?: string; source?: TranscriptSource },
): Promise<TranscriptImporter> {
  if (input.source) {
    const exact = importers.get(input.source);
    if (exact) return exact;
    throw huskError('E_IMPORT_FAILED', `no importer for source "${input.source}"`, {
      hint: `known sources: ${[...importers.keys()].join(', ') || 'none -- build @husk-ai/sessions'}`,
    });
  }
  const detectInput: { path?: string; content?: string } = {};
  if (input.path) detectInput.path = input.path;
  if (input.content) detectInput.content = input.content;

  const scored = await mapLimit([...importers.values()], 4, async (imp) => {
    try {
      return { imp, score: await imp.detect(detectInput) };
    } catch {
      return { imp, score: 0 };
    }
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score <= 0) {
    throw huskError('E_IMPORT_FAILED', 'no importer recognised this transcript', {
      hint: 'pass `source` explicitly, e.g. { "source": "claude-code" }',
    });
  }
  return best.imp;
}

type ToSpecFn = (agent: DistilledAgent, overrides?: { transcript?: Transcript }) => HuskSpec;

/**
 * `DistilledAgent` -> `HuskSpec`, borrowed rather than reimplemented.
 *
 * This route used to carry its own mapper, which wrote `metadata.distillConfidence`
 * while `@husk-ai/sessions` and the CLI wrote `metadata.distilledConfidence`. Same
 * information, two spellings, so a husk distilled over HTTP and one distilled at
 * the terminal did not round-trip to the same file. `toSpec` in `@husk-ai/sessions`
 * is now the only mapper; see docs/reference/husk-yaml for the keys it writes.
 */
async function loadToSpec(): Promise<ToSpecFn> {
  const mod = (await import('@husk-ai/sessions')) as Record<string, unknown>;
  const fn = mod['toSpec'] as ToSpecFn | undefined;
  if (!fn) {
    throw huskError('E_IMPORT_FAILED', '@husk-ai/sessions does not export toSpec', {
      hint: 'run `npm run build --workspace=@husk-ai/sessions`',
    });
  }
  return fn;
}

async function specFromDistilled(distilled: DistilledAgent, transcript: Transcript): Promise<HuskSpec> {
  const toSpec = await loadToSpec();
  return toSpec(distilled, { transcript });
}

async function distill(
  transcript: Transcript,
  useModel: boolean,
  router: unknown,
  model: string | undefined,
): Promise<DistilledAgent> {
  const mod = (await import('@husk-ai/sessions')) as Record<string, unknown>;
  const Ctor = mod['Distiller'] as (new (provider?: unknown) => { distill(t: Transcript): Promise<DistilledAgent> }) | undefined;
  if (!Ctor) {
    throw huskError('E_IMPORT_FAILED', '@husk-ai/sessions does not export a Distiller', {
      hint: 'run `npm run build --workspace=@husk-ai/sessions`',
    });
  }
  // The distiller takes a ModelProvider; the router satisfies the same chat surface,
  // with the model id chosen here rather than by the distiller's hardcoded 'auto'.
  const provider = useModel
    ? {
        id: 'router',
        displayName: 'husk router',
        priority: 0,
        isAvailable: async () => ({ available: true }),
        listModels: async () => [],
        chat: (req: Record<string, unknown>) =>
          (router as { chat(r: unknown): Promise<unknown> }).chat({ ...req, model: model ?? 'auto' }),
        stream: (req: Record<string, unknown>) =>
          (router as { stream(r: unknown): AsyncIterable<unknown> }).stream({ ...req, model: model ?? 'auto' }),
      }
    : undefined;
  return new Ctor(provider).distill(transcript);
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  const { store, router } = ctx.deps;

  app.get('/v1/sessions/discover', async (req) => {
    const q = req.query as { source?: TranscriptSource; path?: string };
    const sources: TranscriptSource[] = q.source ? [q.source] : (Object.keys(DEFAULT_LOCATIONS) as TranscriptSource[]);
    const sessions: DiscoveredSession[] = [];

    for (const source of sources) {
      const roots = q.path ? [q.path] : (DEFAULT_LOCATIONS[source] ?? []);
      for (const root of roots) {
        const files: string[] = [];
        await walk(root, DISCOVER_DEPTH, files);
        const peeked = await mapLimit(files, 8, (f) => peek(f, source));
        for (const s of peeked) if (s) sessions.push(s);
      }
    }

    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions };
  });

  app.post('/v1/sessions/import', async (req) => {
    const body = (req.body ?? {}) as { path?: string; content?: string; source?: TranscriptSource };
    if (!body.path && !body.content) {
      throw huskError('E_IMPORT_FAILED', 'import needs either `path` or `content`', {
        hint: 'POST { "path": "/home/me/.claude/projects/x/session.jsonl" }',
      });
    }
    const importers = await loadImporters();
    const importer = await pickImporter(importers, body);
    const transcripts = await importer.parse(body);
    const transcript = transcripts[0];
    if (!transcript) {
      throw huskError('E_IMPORT_FAILED', `${importer.displayName} found no messages`, {
        hint: 'check the file is a conversation export and not an empty or partial one',
      });
    }
    await store.saveTranscript(transcript);
    return { transcript };
  });

  app.post('/v1/sessions/distill', async (req) => {
    const body = (req.body ?? {}) as {
      transcriptId?: string;
      transcript?: Transcript;
      useModel?: boolean;
      model?: string;
    };
    const transcript = body.transcript ?? (body.transcriptId ? await store.readTranscript(body.transcriptId) : undefined);
    if (!transcript) {
      throw huskError('E_IMPORT_FAILED', 'distill needs either `transcript` or `transcriptId`', {
        hint: 'POST /v1/sessions/import first, then pass the transcript id back',
      });
    }
    const distilled = await distill(transcript, body.useModel === true, router, body.model);
    const spec = await specFromDistilled(distilled, transcript);
    return { distilled, spec, yaml: stringifyYaml(spec, { lineWidth: 100 }) };
  });

  app.post('/v1/sessions/distill/stream', async (req, reply) => {
    const body = (req.body ?? {}) as {
      transcriptId?: string;
      transcript?: Transcript;
      useModel?: boolean;
      model?: string;
    };
    const stream = new SseStream(req, reply);
    try {
      stream.send({ type: 'progress', stage: 'scanning', pct: 0.1 });
      const transcript =
        body.transcript ?? (body.transcriptId ? await store.readTranscript(body.transcriptId) : undefined);
      if (!transcript) {
        throw huskError('E_IMPORT_FAILED', 'distill needs either `transcript` or `transcriptId`', {
          hint: 'POST /v1/sessions/import first, then pass the transcript id back',
        });
      }
      stream.send({ type: 'progress', stage: 'extracting', pct: 0.4 });
      const distilled = await distill(transcript, body.useModel === true, router, body.model);
      stream.send({ type: 'progress', stage: 'merging', pct: 0.8 });
      const spec = await specFromDistilled(distilled, transcript);
      stream.send({ type: 'done', spec, distilled, yaml: stringifyYaml(spec, { lineWidth: 100 }) });
      stream.done();
    } catch (err) {
      if (!stream.signal.aborted) {
        stream.sendError(err);
        stream.done();
      } else {
        stream.close();
      }
    }
    return reply;
  });
}
