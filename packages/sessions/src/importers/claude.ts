import { homedir } from 'node:os';
import { basename, join, dirname, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { HuskError, id } from '@husk/core';
import type { ImportInput, Transcript, TranscriptImporter, TranscriptMessage } from '@husk/core';
import { isDirectory, listFiles, listDirs } from './fsutil.js';
import { stripScaffolding } from '../scaffold.js';

/**
 * Claude Code JSONL.
 *
 * The on-disk format is an append-only event log, not a message list. A line's
 * `type` is one of ~15 values and only `user` / `assistant` lines carry a
 * `.message`. There is no top-level `role` anywhere -- an importer that looks
 * for one finds nothing, which is exactly the bug this file replaces.
 *
 * Lines form a tree via `parentUuid`. Retries and edited prompts fork the tree,
 * so the conversation that actually happened is one root-to-leaf path, not the
 * file in order.
 */

interface RawLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  message?: unknown;
  sessionId?: unknown;
  aiTitle?: unknown;
  customTitle?: unknown;
  summary?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  version?: unknown;
  [k: string]: unknown;
}

interface Node {
  uuid: string;
  parentUuid: string | null;
  type: string;
  timestamp?: string;
  isSidechain: boolean;
  isMeta: boolean;
  role?: string;
  content?: unknown;
  model?: string;
  /** 'typed' / 'paste' / ... Present only on turns a human actually submitted. */
  promptSource?: string;
  /** Raw `origin.kind`: 'human', 'task-notification', ... Kept for provenance. */
  originKind?: string;
}

export interface ClaudeParseStats {
  lines: number;
  unparseable: number;
  truncatedTail: boolean;
  nodes: number;
  chainLength: number;
  /** Message-bearing lines that live on an abandoned retry branch. */
  branchesDropped: number;
  sidechainLines: number;
  /** Messages that had a harness block cut out of otherwise real text. */
  scaffoldingStripped: number;
  /** Messages dropped whole because they were nothing but a harness block. */
  scaffoldingDropped: number;
}

const MESSAGE_TYPES = new Set(['user', 'assistant']);

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse JSONL leniently. A half-written final line is normal -- Claude Code is
 * probably still appending to the file we are reading.
 */
function parseLines(content: string): { rows: RawLine[]; unparseable: number; truncatedTail: boolean } {
  const raw = content.split('\n');
  let lastNonEmpty = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    if ((raw[i] ?? '').trim() !== '') {
      lastNonEmpty = i;
      break;
    }
  }

  const rows: RawLine[] = [];
  let unparseable = 0;
  let truncatedTail = false;

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line || line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) rows.push(parsed as RawLine);
      else unparseable++;
    } catch {
      // Only the very last non-empty line can legitimately be a partial write.
      if (i === lastNonEmpty) truncatedTail = true;
      else unparseable++;
    }
  }
  return { rows, unparseable, truncatedTail };
}

function toNode(row: RawLine): Node | undefined {
  const uuid = asString(row.uuid);
  if (!uuid) return undefined;
  const msg = isRecord(row.message) ? row.message : undefined;
  const node: Node = {
    uuid,
    parentUuid: asString(row.parentUuid) ?? null,
    type: asString(row.type) ?? 'unknown',
    isSidechain: row.isSidechain === true,
    isMeta: row.isMeta === true,
  };
  const ts = asString(row.timestamp);
  if (ts) node.timestamp = ts;
  const origin = isRecord(row.origin) ? row.origin : undefined;
  const originKind = asString(origin?.kind);
  const rawPromptSource = asString(row.promptSource);
  if (originKind) node.originKind = originKind;

  // `origin.kind` is the authoritative discriminator, and `promptSource` alone
  // is not evidence of a human. The harness stamps `promptSource: "sdk"` on the
  // task-notification lines it injects, so treating the field as proof handed
  // the distiller a subagent's completion report as though someone had typed
  // it -- which is how a husk ended up with `<task-notification>` in its
  // system prompt. Fall back to `promptSource` only when there is no `origin`
  // at all, for transcripts written before Claude Code recorded one.
  const human = originKind
    ? originKind === 'human'
    : rawPromptSource !== undefined && rawPromptSource !== 'sdk';
  if (human) node.promptSource = rawPromptSource ?? 'human';
  if (msg) {
    const role = asString(msg.role);
    if (role) node.role = role;
    node.content = msg.content;
    const model = asString(msg.model);
    if (model) node.model = model;
  }
  return node;
}

/** Every tool_use id -> tool name seen anywhere in the file, sidechains included. */
function harvestToolNames(rows: RawLine[]): {
  byId: Map<string, string>;
  mainThreadTools: Set<string>;
  sidechainTools: Set<string>;
} {
  const byId = new Map<string, string>();
  const mainThreadTools = new Set<string>();
  const sidechainTools = new Set<string>();
  for (const row of rows) {
    const msg = isRecord(row.message) ? row.message : undefined;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!isRecord(part) || part.type !== 'tool_use') continue;
      const name = asString(part.name);
      if (!name) continue;
      const callId = asString(part.id);
      if (callId) byId.set(callId, name);
      if (row.isSidechain === true) sidechainTools.add(name);
      else mainThreadTools.add(name);
    }
  }
  return { byId, mainThreadTools, sidechainTools };
}

/**
 * The path that actually happened.
 *
 * Leaves are ranked by chain length first: a retried turn abandons its branch,
 * and the branch the user kept going down is the longer one. Timestamp breaks
 * ties, which is what "the last leaf" means when nothing was retried.
 */
function reconstructThread(nodes: Node[]): { chain: Node[]; leaves: number } {
  const byUuid = new Map<string, Node>();
  for (const n of nodes) byUuid.set(n.uuid, n);

  const hasChild = new Set<string>();
  for (const n of nodes) if (n.parentUuid && byUuid.has(n.parentUuid)) hasChild.add(n.parentUuid);

  const leaves = nodes.filter((n) => !hasChild.has(n.uuid));
  if (!leaves.length) return { chain: [], leaves: 0 };

  const walk = (leaf: Node): Node[] => {
    const out: Node[] = [];
    const seen = new Set<string>();
    let cur: Node | undefined = leaf;
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      out.push(cur);
      cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
    }
    return out.reverse();
  };

  let best: Node[] = [];
  let bestTs = '';
  for (const leaf of leaves) {
    const chain = walk(leaf);
    const ts = leaf.timestamp ?? '';
    if (chain.length > best.length || (chain.length === best.length && ts > bestTs)) {
      best = chain;
      bestTs = ts;
    }
  }
  return { chain: best, leaves: leaves.length };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!isRecord(part)) return '';
        if (part.type === 'text') return asString(part.text) ?? '';
        if (part.type === 'image') {
          const src = isRecord(part.source) ? part.source : undefined;
          return `[image: ${asString(src?.media_type) ?? 'unknown'}]`;
        }
        if (part.type === 'tool_reference') return `[tool reference: ${asString(part.name) ?? '?'}]`;
        return JSON.stringify(part);
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Counters threaded through `emit` so the stats can report what was cut. */
interface ScaffoldTally {
  stripped: number;
  dropped: number;
}

/**
 * Cut harness plumbing out of one turn's prose.
 *
 * Returns undefined when nothing survives, which means the turn was pure
 * scaffolding and should never have been a message in the first place.
 */
function clean(text: string, tally: ScaffoldTally): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const stripped = stripScaffolding(trimmed).trim();
  if (stripped === trimmed) return trimmed;
  if (!stripped) {
    tally.dropped++;
    return undefined;
  }
  tally.stripped++;
  return stripped;
}

/** One chain node becomes zero or more transcript messages. */
function emit(node: Node, toolNames: Map<string, string>, tally: ScaffoldTally): TranscriptMessage[] {
  if (!MESSAGE_TYPES.has(node.type) || node.content === undefined) return [];
  const ts = node.timestamp;
  const out: TranscriptMessage[] = [];
  const role: 'user' | 'assistant' = node.role === 'assistant' ? 'assistant' : 'user';

  // isMeta turns are injected, not spoken: image placeholders, loaded skill
  // documents, hook output. Claude Code flags them; the distiller must not read
  // a pasted-in skill file as something the user asked for.
  if (node.isMeta) return [];

  // Only a turn a human submitted carries promptSource / origin.kind.
  const human = node.promptSource ? { promptSource: node.promptSource } : undefined;

  if (typeof node.content === 'string') {
    const text = clean(node.content, tally);
    if (!text) return [];
    out.push({ role, content: text, ...(ts ? { ts } : {}), ...(human ? { meta: human } : {}) });
    return out;
  }

  if (!Array.isArray(node.content)) return [];

  const textChunks: string[] = [];
  let thinkingBlocks = 0;

  const flushText = () => {
    const joined = clean(textChunks.join('\n\n'), tally);
    textChunks.length = 0;
    if (!joined) return;
    const msg: TranscriptMessage = { role, content: joined, ...(ts ? { ts } : {}) };
    if (thinkingBlocks || human) msg.meta = { ...(human ?? {}), ...(thinkingBlocks ? { thinkingBlocks } : {}) };
    out.push(msg);
  };

  for (const part of node.content) {
    if (typeof part === 'string') {
      textChunks.push(part);
      continue;
    }
    if (!isRecord(part)) continue;

    switch (part.type) {
      case 'text': {
        const t = asString(part.text);
        if (t) textChunks.push(t);
        break;
      }
      case 'thinking':
      case 'redacted_thinking': {
        // Reasoning is not the answer, and its signature is provider-internal.
        thinkingBlocks++;
        break;
      }
      case 'image': {
        const src = isRecord(part.source) ? part.source : undefined;
        textChunks.push(`[image: ${asString(src?.media_type) ?? 'unknown'}]`);
        break;
      }
      case 'tool_use': {
        flushText();
        const name = asString(part.name) ?? 'unknown';
        const callId = asString(part.id);
        out.push({
          role: 'assistant',
          content: `[tool: ${name}]`,
          ...(ts ? { ts } : {}),
          toolName: name,
          toolInput: part.input,
          ...(callId ? { meta: { toolUseId: callId } } : {}),
        });
        break;
      }
      case 'tool_result': {
        flushText();
        const callId = asString(part.tool_use_id);
        const name = callId ? toolNames.get(callId) : undefined;
        out.push({
          role: 'tool',
          // Stripped but never dropped: an empty result still has to stay
          // paired with the tool_use that produced it.
          content: stripScaffolding(stringifyToolResult(part.content)),
          ...(ts ? { ts } : {}),
          ...(name ? { toolName: name } : {}),
          meta: {
            ...(callId ? { toolUseId: callId } : {}),
            ...(part.is_error === true ? { isError: true } : {}),
          },
        });
        break;
      }
      default:
        break;
    }
  }
  flushText();
  return out;
}

export interface ParsedClaudeTranscript {
  transcript: Transcript;
  stats: ClaudeParseStats;
}

/**
 * Parse one Claude Code JSONL document. Exported so tests and `discover()` can
 * use it without touching the filesystem.
 */
export function parseClaudeJsonl(content: string, origin?: string): ParsedClaudeTranscript | undefined {
  const { rows, unparseable, truncatedTail } = parseLines(content);
  if (!rows.length) return undefined;

  const { byId: toolNames, mainThreadTools, sidechainTools } = harvestToolNames(rows);

  const allNodes: Node[] = [];
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let sidechainLines = 0;
  const models = new Map<string, number>();

  for (const row of rows) {
    const t = asString(row.type);
    if (t === 'ai-title') aiTitle = asString(row.aiTitle) ?? aiTitle;
    else if (t === 'custom-title') customTitle = asString(row.customTitle) ?? customTitle;
    else if (t === 'summary') aiTitle = aiTitle ?? asString(row.summary);
    sessionId = sessionId ?? asString(row.sessionId);
    cwd = cwd ?? asString(row.cwd);
    gitBranch = gitBranch ?? asString(row.gitBranch);
    version = asString(row.version) ?? version;
    if (row.isSidechain === true) sidechainLines++;

    const node = toNode(row);
    if (!node) continue;
    if (node.model) models.set(node.model, (models.get(node.model) ?? 0) + 1);
    allNodes.push(node);
  }

  // Subagent traffic is a different conversation. It stays out of the thread,
  // but its tool names still describe what the resulting bot has to be able to do.
  const mainNodes = allNodes.filter((n) => !n.isSidechain);
  const { chain } = reconstructThread(mainNodes);

  const messages: TranscriptMessage[] = [];
  const tally: ScaffoldTally = { stripped: 0, dropped: 0 };
  for (const node of chain) messages.push(...emit(node, toolNames, tally));

  const chainMessageNodes = chain.filter((n) => MESSAGE_TYPES.has(n.type)).length;
  const totalMessageNodes = mainNodes.filter((n) => MESSAGE_TYPES.has(n.type)).length;

  const timestamps = chain.map((n) => n.timestamp).filter((t): t is string => !!t);
  const topModel = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const title =
    customTitle ??
    aiTitle ??
    messages.find((m) => m.role === 'user')?.content.slice(0, 80).replace(/\s+/g, ' ').trim();

  const transcript: Transcript = {
    id: sessionId ?? (origin ? basename(origin, extname(origin)) : id('claude')),
    source: 'claude-code',
    messages,
    ...(title ? { title } : {}),
    ...(timestamps.length
      ? { createdAt: timestamps[0], updatedAt: timestamps[timestamps.length - 1] }
      : {}),
    ...(origin ? { origin } : {}),
    meta: {
      ...(cwd ? { cwd } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(version ? { claudeCodeVersion: version } : {}),
      ...(topModel ? { model: topModel } : {}),
      tools: [...mainThreadTools].sort(),
      ...(sidechainTools.size ? { sidechainTools: [...sidechainTools].sort() } : {}),
    },
  };

  return {
    transcript,
    stats: {
      lines: rows.length,
      unparseable,
      truncatedTail,
      nodes: mainNodes.length,
      chainLength: chain.length,
      branchesDropped: Math.max(0, totalMessageNodes - chainMessageNodes),
      sidechainLines,
      scaffoldingStripped: tally.stripped,
      scaffoldingDropped: tally.dropped,
    },
  };
}

/** Newer Claude Code writes subagent transcripts to `<sessionId>/subagents/*.jsonl`. */
async function siblingSubagentTools(filePath: string): Promise<string[]> {
  const sessionDir = join(dirname(filePath), basename(filePath, extname(filePath)), 'subagents');
  const files = await listFiles(sessionDir, '.jsonl');
  const names = new Set<string>();
  for (const f of files.slice(0, 64)) {
    try {
      const { rows } = parseLines(await readFile(f, 'utf8'));
      const harvested = harvestToolNames(rows);
      for (const n of harvested.sidechainTools) names.add(n);
      for (const n of harvested.mainThreadTools) names.add(n);
    } catch {
      // A subagent log we cannot read is not a reason to fail the import.
    }
  }
  return [...names].sort();
}

export class ClaudeCodeImporter implements TranscriptImporter {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';

  async detect(input: { path?: string; content?: string }): Promise<number> {
    try {
      const path = input.path?.replace(/\\/g, '/').toLowerCase();
      let score = 0;
      if (path?.includes('/.claude/projects/')) score = 0.7;
      else if (path?.endsWith('.jsonl')) score = 0.35;

      const probe = input.content?.slice(0, 64 * 1024);
      if (probe) {
        const markers = [
          /"parentUuid"\s*:/,
          /"isSidechain"\s*:/,
          /"type"\s*:\s*"(assistant|user)"/,
          /"toolUseResult"/,
          /"type"\s*:\s*"(ai-title|last-prompt|permission-mode)"/,
          /"sessionId"\s*:/,
        ].filter((re) => re.test(probe)).length;
        if (markers >= 3) score = Math.max(score, 0.97);
        else if (markers === 2) score = Math.max(score, 0.6);
        else if (markers === 1) score = Math.max(score, 0.2);
      }
      return score;
    } catch {
      return 0;
    }
  }

  async parse(input: ImportInput): Promise<Transcript[]> {
    if (input.content !== undefined) {
      const parsed = parseClaudeJsonl(input.content, input.path);
      return parsed && parsed.transcript.messages.length ? [attachStats(parsed)] : [];
    }
    if (!input.path) {
      throw new HuskError('E_IMPORT_FAILED', 'Claude Code import needs a path or content.', {
        hint: 'Pass { path } pointing at a .jsonl file or a directory, or pass { content }.',
      });
    }

    const files = (await isDirectory(input.path))
      ? await listFiles(input.path, '.jsonl')
      : [input.path];

    const out: Transcript[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch (cause) {
        throw new HuskError('E_IMPORT_FAILED', `Cannot read ${file}.`, {
          hint: 'Check the path exists and is readable.',
          cause,
        });
      }
      const parsed = parseClaudeJsonl(content, file);
      if (!parsed || !parsed.transcript.messages.length) continue;
      const extra = await siblingSubagentTools(file);
      if (extra.length) {
        const meta = parsed.transcript.meta ?? {};
        const known = new Set(Array.isArray(meta.sidechainTools) ? (meta.sidechainTools as string[]) : []);
        for (const n of extra) known.add(n);
        parsed.transcript.meta = { ...meta, sidechainTools: [...known].sort() };
      }
      out.push(attachStats(parsed));
    }
    return out;
  }

  defaultLocations(): string[] {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    const roots = configDir
      ? configDir.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
      : [join(homedir(), '.claude'), join(homedir(), '.config', 'claude')];
    return roots.map((r) => join(r, 'projects'));
  }

  /** Every per-project directory under the Claude projects root. */
  async projectDirs(): Promise<string[]> {
    const out: string[] = [];
    for (const root of this.defaultLocations()) out.push(...(await listDirs(root)));
    return out;
  }
}

function attachStats(parsed: ParsedClaudeTranscript): Transcript {
  parsed.transcript.meta = { ...(parsed.transcript.meta ?? {}), parse: parsed.stats };
  return parsed.transcript;
}
