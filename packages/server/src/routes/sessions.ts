import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { findCli, mapLimit, parseSpec, slug } from '@husk-ai/core';
import type { DistilledAgent, HuskSpec, Transcript, TranscriptImporter, TranscriptSource } from '@husk-ai/core';
import type { FastifyInstance } from 'fastify';
import { stringify as stringifyYaml } from 'yaml';
import { ctxOf } from '../context.js';
import { huskError, notFound } from '../errors.js';
import { SseStream } from '../sse.js';

/**
 * Where each tool keeps its history.
 *
 * `TranscriptImporter` declares an optional `defaultLocations()` and none of the
 * shipped importers implement it, so discovery cannot delegate. These are the
 * fallbacks; an importer that grows the method overrides them.
 */
function defaultLocations(home = homedir(), env: NodeJS.ProcessEnv = process.env): Partial<Record<TranscriptSource, string[]>> {
  const config =
    process.platform === 'win32'
      ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return {
    'claude-code': [join(home, '.claude', 'projects'), join(home, '.config', 'claude', 'projects')],
    codex: [codexSessions(home, env)],
    // Cursor keeps every chat in one SQLite file; importing it asks which one.
    cursor: [join(config, 'Cursor', 'User', 'globalStorage', 'state.vscdb')],
    gemini: [join(home, '.gemini', 'tmp')],
  };
}

/** Where Codex keeps its sessions, one rollout-*.jsonl each, by date. */
function codexSessions(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(home, '.codex'), 'sessions');
}

const DISCOVER_FILE_LIMIT = 200;
const DISCOVER_DEPTH = 3;

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0 || out.length >= DISCOVER_FILE_LIMIT) return;
  // Newest first where names are dates (Codex's YYYY/MM/DD), so the limit keeps the recent ones.
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => String(b.name).localeCompare(String(a.name)));
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
  let title = file.toLowerCase().endsWith('.vscdb') ? 'Every Cursor chat (pick one when importing)' : basename(file).replace(/\.(jsonl|json|md)$/i, '');
  if (file.toLowerCase().endsWith('.jsonl')) {
    try {
      const head = await readFile(file, 'utf8');
      const lines = head.split('\n').filter((l) => l.trim().length > 0);
      messageCount = lines.length;
      for (const line of lines) {
        try {
          // A title, a summary, Claude Code's own title, or Codex's first message from the person.
          const obj = JSON.parse(line) as { summary?: unknown; title?: unknown; aiTitle?: unknown; type?: unknown; payload?: { type?: unknown; message?: unknown } };
          const said = obj.type === 'event_msg' && obj.payload?.type === 'user_message' ? obj.payload.message : undefined;
          const found = [obj.summary, obj.title, obj.aiTitle, said].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
          if (found) {
            title = found.slice(0, 120).replace(/\s+/g, ' ').trim();
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

/**
 * The transcript file of a Claude Code session: `<project>/<session id>.jsonl`
 * under Claude Code's projects directory. The id is checked to be a plain
 * token first, so it can never name a path of its own.
 */
export async function claudeCodeTranscript(sessionId: string, roots = defaultLocations()['claude-code'] ?? []): Promise<string | undefined> {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return undefined;
  for (const root of roots) {
    const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const file = join(root, String(project.name), `${sessionId}.jsonl`);
      if (await stat(file).then((s) => s.isFile(), () => false)) return file;
    }
  }
  return undefined;
}

/**
 * The Codex rollout of the chat that made this computer: the newest one,
 * written since the computer was, that names it. Codex hands its MCP servers
 * no session id, but the first call's answer carries the computer's.
 */
export async function codexTranscript(computerId: string, since: number, root = codexSessions()): Promise<string | undefined> {
  if (!/^cmp_[A-Za-z0-9]+$/.test(computerId)) return undefined;
  const files = (await readdir(root, { recursive: true }).catch(() => [] as string[])).filter((f) => /rollout-[^\\/]*\.jsonl$/.test(f));
  const dated = await mapLimit(files, 16, async (f) => ({ file: join(root, f), at: (await stat(join(root, f)).catch(() => undefined))?.mtimeMs ?? 0 }));
  const recent = dated.filter((d) => d.at >= since).sort((a, b) => b.at - a.at).slice(0, 300);
  for (const { file } of recent) if ((await readFile(file, 'utf8').catch(() => '')).includes(computerId)) return file;
  return undefined;
}

/** What a bot made from a chat runs on: the person's Claude Code or Codex, or Husk's own engine. */
type BotEngine = 'claude-code' | 'codex' | 'builtin';

/** The engines a bot from this chat can run on, best first: the chat's own app, when it is installed, then any other, then Husk's own. */
function enginesFor(transcript: Transcript): BotEngine[] {
  const own = transcript.source === 'claude-code' || transcript.source === 'codex' ? transcript.source : undefined;
  const installed = (['claude-code', 'codex'] as const).filter((cli) => findCli(cli) !== undefined);
  return [...(own && installed.includes(own) ? [own] : []), ...installed.filter((cli) => cli !== own), 'builtin'];
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  const { store, router } = ctx.deps;

  /**
   * A bot draft from a chat, on the engine asked for or the best one there
   * is. On Claude Code a Claude Code chat goes on as itself (`resume`); on
   * any other CLI the bot starts fresh, from what was distilled.
   */
  const draftOf = async (transcript: Transcript, body: { useModel?: boolean; model?: string; engine?: BotEngine }) => {
    const distilled = await distill(transcript, body.useModel === true, router, body.model);
    const draft = await specFromDistilled(distilled, transcript);
    const engines = enginesFor(transcript);
    const engine = body.engine && engines.includes(body.engine) ? body.engine : engines[0]!;
    // Whether Claude Code would go on with this chat, rather than start from the draft.
    const continues = transcript.source === 'claude-code' && /^[A-Za-z0-9-]{8,80}$/.test(transcript.id);
    const resume = engine === 'claude-code' && continues ? transcript.id : undefined;
    const spec = engine === 'builtin' ? draft : parseSpec({ ...draft, model: 'auto', engine: { type: engine, ...(resume ? { resume } : {}) } });
    return { transcriptId: transcript.id, distilled, spec, yaml: stringifyYaml(spec, { lineWidth: 100 }), engines, continues };
  };

  /**
   * "Make this a bot": distill the chat that owns this computer into a husk
   * draft. Only a Claude Code chat can be read back, because its transcript is
   * a file named after the session id Husk recorded; for any other app the
   * person exports the chat and imports it.
   *
   * Where the person's Claude Code is installed, the draft runs on it and
   * continues this chat, on this computer (`engine: claude-code`); otherwise,
   * or when asked (`engine: builtin`), on Husk's own engine and any model.
   */
  app.post('/v1/computers/:id/bot', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { useModel?: boolean; model?: string; engine?: BotEngine };
    const computer = await ctx.deps.manager.get(id);
    if (!computer) throw notFound('computer', id);
    // A Claude Code chat by the session id Husk recorded; a Codex chat by its rollout, which names this computer.
    const sessionId = computer.info.spec?.labels?.['husk.session'];
    const claude = sessionId ? await claudeCodeTranscript(sessionId) : undefined;
    const since = Date.parse(computer.info.createdAt) - 60_000;
    const codex = sessionId ? undefined : await codexTranscript(id, Number.isNaN(since) ? 0 : since);
    const path = claude ?? codex;
    if (!path) {
      throw huskError('E_IMPORT_FAILED', 'Husk cannot read this chat back from its app', {
        hint: sessionId
          ? 'its Claude Code transcript was not found under ~/.claude/projects'
          : 'Husk reads Claude Code and Codex chats directly; for any other app, export the chat and use Husks, Make a bot from a chat',
      });
    }
    const importers = await loadImporters();
    const importer = await pickImporter(importers, { path, source: claude ? 'claude-code' : 'codex' });
    const transcript = (await importer.parse({ path }))[0];
    if (!transcript) throw huskError('E_IMPORT_FAILED', 'the chat has no messages yet');
    await store.saveTranscript(transcript);
    return draftOf(transcript, body);
  });

  app.get('/v1/sessions/discover', async (req) => {
    const q = req.query as { source?: TranscriptSource; path?: string };
    const locations = defaultLocations();
    const sources: TranscriptSource[] = q.source ? [q.source] : (Object.keys(locations) as TranscriptSource[]);
    const sessions: DiscoveredSession[] = [];

    for (const source of sources) {
      const roots = q.path ? [q.path] : (locations[source] ?? []);
      for (const root of roots) {
        const files: string[] = [];
        // A root may be one file: Cursor's state.vscdb.
        if (await stat(root).then((s) => s.isFile(), () => false)) files.push(root);
        else await walk(root, DISCOVER_DEPTH, files);
        const peeked = await mapLimit(files, 8, (f) => peek(f, source));
        for (const s of peeked) if (s) sessions.push(s);
      }
    }

    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions };
  });

  /**
   * A chat from a file or pasted text. A file that holds many chats (a
   * ChatGPT export, Cursor's state.vscdb) answers with `choices`, newest
   * first, and nothing is kept until the caller asks again with `pick`.
   */
  app.post('/v1/sessions/import', async (req) => {
    const body = (req.body ?? {}) as { path?: string; content?: string; source?: TranscriptSource; pick?: string };
    if (!body.path && !body.content) {
      throw huskError('E_IMPORT_FAILED', 'import needs either `path` or `content`', {
        hint: 'POST { "path": "/home/me/.claude/projects/x/session.jsonl" }',
      });
    }
    const importers = await loadImporters();
    const importer = await pickImporter(importers, body);
    const transcripts = await importer.parse({ ...(body.path ? { path: body.path } : {}), ...(body.content ? { content: body.content } : {}) });
    if (!transcripts.length) {
      throw huskError('E_IMPORT_FAILED', `${importer.displayName} found no messages`, {
        hint: 'check the file is a conversation export and not an empty or partial one',
      });
    }
    const transcript = body.pick ? transcripts.find((t) => t.id === body.pick) : transcripts.length === 1 ? transcripts[0] : undefined;
    if (!transcript) {
      if (body.pick) throw huskError('E_IMPORT_FAILED', `no chat ${body.pick} in this file`, { hint: 'import it without `pick` to list the chats it holds' });
      const when = (t: Transcript) => t.updatedAt ?? t.createdAt ?? '';
      const choices = [...transcripts]
        .sort((a, b) => when(b).localeCompare(when(a)))
        .slice(0, 200)
        .map((t) => ({ id: t.id, title: t.title ?? t.messages.find((m) => m.role === 'user')?.content.slice(0, 80) ?? t.id, messages: t.messages.length, ...(when(t) ? { updatedAt: when(t) } : {}) }));
      return { source: importer.id, choices };
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
      engine?: BotEngine;
    };
    const transcript = body.transcript ?? (body.transcriptId ? await store.readTranscript(body.transcriptId) : undefined);
    if (!transcript) {
      throw huskError('E_IMPORT_FAILED', 'distill needs either `transcript` or `transcriptId`', {
        hint: 'POST /v1/sessions/import first, then pass the transcript id back',
      });
    }
    return draftOf(transcript, body);
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
