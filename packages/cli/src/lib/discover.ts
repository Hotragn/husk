import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { TranscriptSource } from '@husk-ai/core';
import { parseClaudeJsonl, parseMarkdownChat } from '@husk-ai/sessions';

/**
 * Find transcripts without being told where they are.
 *
 * `TranscriptImporter.defaultLocations()` is optional on the contract and no
 * importer in `@husk-ai/sessions` implements it yet, so discovery lives here. When
 * they do, this collapses into asking them -- the shape below is deliberately
 * the same.
 *
 * The scan is bounded: a fixed set of roots, a depth cap, and a file cap. An
 * import command that walks a whole home directory is one people run once.
 */
export interface Candidate {
  path: string;
  source: TranscriptSource;
  title: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface Root {
  dir: string;
  source: TranscriptSource;
  match: RegExp;
  depth: number;
  /** Read a prefix and require it to look like a chat, not just carry the extension. */
  sniff?: boolean;
}

/** Enough of a file to see whether a conversation starts -- a chat that does
 * not begin in the first 32 KB is not what discovery is for. */
const SNIFF_BYTES = 32 * 1024;

async function sniffsAsChat(path: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    if (bytesRead === 0) return false;
    // Two messages minimum: one role marker can be a coincidence in prose.
    return (parseMarkdownChat(buf.subarray(0, bytesRead).toString('utf8'))?.messages.length ?? 0) >= 2;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

function roots(cwd: string): Root[] {
  const home = homedir();
  return [
    // Claude Code keeps one JSONL per session under a per-project directory.
    { dir: join(home, '.claude', 'projects'), source: 'claude-code', match: /\.jsonl$/i, depth: 2 },
    { dir: join(home, '.claude'), source: 'claude-code', match: /\.jsonl$/i, depth: 1 },
    // A ChatGPT export lands in Downloads as conversations.json.
    { dir: join(home, 'Downloads'), source: 'chatgpt', match: /^conversations.*\.json$/i, depth: 1 },
    { dir: join(home, 'Downloads'), source: 'universal', match: /chat.*\.json$/i, depth: 1 },
    { dir: join(home, '.cursor'), source: 'cursor', match: /\.(json|jsonl)$/i, depth: 2 },
    // Anything the user is standing next to. Markdown is content-sniffed: a
    // repo's CHANGELOG is not a pasted chat, and offering it as one made
    // discovery useless exactly where people try it first.
    { dir: cwd, source: 'markdown', match: /\.(md|markdown)$/i, depth: 1, sniff: true },
    { dir: cwd, source: 'universal', match: /\.(jsonl)$/i, depth: 1 },
  ];
}

const MAX_FILES = 400;

export async function discover(opts: { cwd?: string; source?: string; limit?: number } = {}): Promise<Candidate[]> {
  const cwd = opts.cwd ?? process.cwd();
  const found = new Map<string, Candidate>();

  for (const root of roots(cwd)) {
    if (opts.source && root.source !== opts.source) continue;
    if (found.size >= MAX_FILES) break;
    await walk(root.dir, root, 0, found);
  }

  const list = [...found.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return opts.limit ? list.slice(0, opts.limit) : list;
}

async function walk(dir: string, root: Root, depth: number, out: Map<string, Candidate>): Promise<void> {
  if (depth > root.depth || out.size >= MAX_FILES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A root that does not exist is the normal case, not an error worth showing.
    return;
  }

  for (const entry of entries) {
    if (out.size >= MAX_FILES) return;
    if (entry.name.startsWith('.') && depth > 0) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(full, root, depth + 1, out);
      continue;
    }
    if (!entry.isFile() || !root.match.test(entry.name)) continue;
    if (out.has(full)) continue;

    const st = await stat(full).catch(() => null);
    if (!st || st.size === 0) continue;
    // A multi-hundred-megabyte JSON is not a chat someone meant to import.
    if (st.size > 64 * 1024 * 1024) continue;
    if (root.sniff && !(await sniffsAsChat(full))) continue;

    out.set(full, {
      path: full,
      source: root.source,
      title: await prettyTitle(full, root.source),
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
    });
  }
}

/**
 * A readable label.
 *
 * Claude Code names its files after a session uuid, which tells a human nothing.
 * Its encoded parent name cannot be decoded without confusing literal dashes
 * with separators, so prefer the exact cwd from the bounded transcript prefix.
 * The raw parent name is a truthful fallback when cwd is unavailable.
 */
export async function prettyTitle(path: string, source: TranscriptSource): Promise<string> {
  const file = basename(path);
  if (source === 'claude-code') {
    const parent = basename(join(path, '..'));
    let project = parent;
    try {
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.alloc(SNIFF_BYTES);
        const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
        const parsed = parseClaudeJsonl(buf.subarray(0, bytesRead).toString('utf8'), path);
        const cwd = parsed?.transcript.meta?.cwd;
        if (typeof cwd === 'string' && cwd.length > 0) project = cwd;
      } finally {
        await fh.close();
      }
    } catch {
      // Discovery still returns a useful, truthful label if the file changes
      // or becomes unreadable between readdir and this bounded prefix read.
    }
    return project && project !== '.claude' ? `${project}  ${file.slice(0, 8)}` : file;
  }
  return file;
}
