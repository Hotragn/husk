import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { HuskError, id } from '@husk/core';
import type { ImportInput, Transcript, TranscriptImporter, TranscriptMessage } from '@husk/core';
import { isDirectory, listFiles } from './fsutil.js';

/**
 * Cursor chat history.
 *
 * Cursor keeps chats inside VS Code's `state.vscdb`, which is SQLite. Husk
 * forbids native modules, so there is no SQLite driver here and there will not
 * be one. What this importer does instead:
 *
 *  - parses Cursor's own JSON/markdown chat exports properly, and
 *  - for a raw `state.vscdb`, scans the file for the embedded JSON blobs Cursor
 *    stores as text values and parses the ones that are complete.
 *
 * The second path is best-effort and says so. It recovers whole chats when the
 * blob is not spread across SQLite overflow pages, and recovers nothing when it
 * is -- it never invents a partial conversation.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Cursor encodes the speaker as `type: 1` (user) / `type: 2` (assistant). */
function bubbleRole(bubble: Record<string, unknown>): TranscriptMessage['role'] {
  if (bubble.type === 1) return 'user';
  if (bubble.type === 2) return 'assistant';
  const t = asString(bubble.type) ?? asString(bubble.role) ?? asString(bubble.author);
  switch ((t ?? '').toLowerCase()) {
    case 'assistant':
    case 'ai':
    case 'bot':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
    default:
      return 'user';
  }
}

function bubbleText(bubble: Record<string, unknown>): string {
  const direct =
    asString(bubble.text) ?? asString(bubble.rawText) ?? asString(bubble.content) ?? asString(bubble.message);
  if (direct) return direct;
  if (Array.isArray(bubble.parts)) {
    return bubble.parts
      .map((p) => (typeof p === 'string' ? p : isRecord(p) ? (asString(p.text) ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function bubblesToMessages(bubbles: unknown[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const b of bubbles) {
    if (!isRecord(b)) continue;
    const text = bubbleText(b).trim();
    const toolName = asString(b.toolName) ?? (isRecord(b.toolFormerData) ? asString(b.toolFormerData.name) : undefined);
    if (!text && !toolName) continue;
    const ts = typeof b.timestamp === 'number' ? new Date(b.timestamp).toISOString() : asString(b.timestamp);
    out.push({
      role: toolName ? 'tool' : bubbleRole(b),
      content: text,
      ...(ts ? { ts } : {}),
      ...(toolName ? { toolName } : {}),
    });
  }
  return out;
}

/** Walk any shape and pull out things that look like a Cursor conversation. */
function collectConversations(root: unknown, origin: string | undefined): Transcript[] {
  const out: Transcript[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > 12 || !node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;

    for (const key of ['bubbles', 'conversation', 'messages', 'richText'] as const) {
      const value = rec[key];
      if (!Array.isArray(value)) continue;
      const messages = bubblesToMessages(value);
      if (messages.length >= 2) {
        out.push({
          id: asString(rec.composerId) ?? asString(rec.tabId) ?? asString(rec.id) ?? id('cursor'),
          source: 'cursor',
          messages,
          ...(asString(rec.name) ?? asString(rec.title)
            ? { title: (asString(rec.name) ?? asString(rec.title)) as string }
            : {}),
          ...(origin ? { origin } : {}),
        });
        return;
      }
    }

    for (const value of Object.values(rec)) visit(value, depth + 1);
  };

  visit(root, 0);
  return out;
}

/** Pull balanced JSON objects out of a binary blob. Only complete ones survive. */
function salvageJsonObjects(text: string, max = 400): unknown[] {
  const out: unknown[] = [];
  const anchors = /\{"(?:composerId|tabs|conversation|bubbles|richText)"/g;
  let m: RegExpExecArray | null;
  while ((m = anchors.exec(text)) !== null && out.length < max) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = m.index; i < text.length && i - m.index < 8_000_000; i++) {
      const ch = text[i] as string;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      out.push(JSON.parse(text.slice(m.index, end)));
    } catch {
      // Truncated by a SQLite overflow page boundary. Nothing recoverable here.
    }
  }
  return out;
}

export class CursorImporter implements TranscriptImporter {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor chat';

  async detect(input: { path?: string; content?: string }): Promise<number> {
    try {
      const path = input.path?.replace(/\\/g, '/').toLowerCase();
      let score = 0;
      if (path?.endsWith('.vscdb')) score = path.includes('cursor') ? 0.85 : 0.5;
      else if (path?.includes('/cursor/') && path.endsWith('.json')) score = 0.6;

      const probe = input.content?.slice(0, 64 * 1024);
      if (probe) {
        if (probe.startsWith('SQLite format 3')) score = Math.max(score, 0.55);
        const markers = [/"composerId"/, /"bubbles"/, /"toolFormerData"/, /"richText"/, /"composerData"/].filter((re) =>
          re.test(probe),
        ).length;
        if (markers >= 2) score = Math.max(score, 0.9);
        else if (markers === 1) score = Math.max(score, 0.55);
      }
      return score;
    } catch {
      return 0;
    }
  }

  async parse(input: ImportInput): Promise<Transcript[]> {
    let content = input.content;
    if (content === undefined) {
      if (!input.path) {
        throw new HuskError('E_IMPORT_FAILED', 'Cursor import needs a path or content.', {
          hint: 'Point it at a Cursor chat export, or at globalStorage/state.vscdb.',
        });
      }
      const files = (await isDirectory(input.path))
        ? [...(await listFiles(input.path, '.json')), ...(await listFiles(input.path, '.vscdb'))]
        : [input.path];
      const all: Transcript[] = [];
      for (const f of files) all.push(...(await this.parse({ path: f, content: await readFile(f, 'latin1') })));
      return all;
    }

    const origin = input.path;
    const binary = content.startsWith('SQLite format 3');

    if (!binary) {
      try {
        return collectConversations(JSON.parse(content), origin);
      } catch {
        // Not JSON. Fall through to the salvage path, which handles the case
        // where a JSON blob is embedded in something else.
      }
    }
    return collectConversations(salvageJsonObjects(content), origin);
  }

  defaultLocations(): string[] {
    const home = homedir();
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      return [join(appData, 'Cursor', 'User', 'globalStorage')];
    }
    if (process.platform === 'darwin') {
      return [join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')];
    }
    return [join(home, '.config', 'Cursor', 'User', 'globalStorage')];
  }
}
