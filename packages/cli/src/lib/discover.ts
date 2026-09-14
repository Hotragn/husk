import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { TranscriptSource } from '@husk-ai/core';

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
    // Anything the user is standing next to.
    { dir: cwd, source: 'markdown', match: /\.(md|markdown)$/i, depth: 1 },
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

    out.set(full, {
      path: full,
      source: root.source,
      title: prettyTitle(full, root.source),
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
    });
  }
}

/**
 * A readable label.
 *
 * Claude Code names its files after a session uuid, which tells a human nothing,
 * so the project directory above it is used instead -- that is the name they
 * would recognise.
 */
function prettyTitle(path: string, source: TranscriptSource): string {
  const file = basename(path);
  if (source === 'claude-code') {
    const parent = basename(join(path, '..'));
    const project = parent.replace(/^-+/, '').replace(/-/g, '/');
    return project && project !== '.claude' ? `${project}  ${file.slice(0, 8)}` : file;
  }
  return file;
}
