import { HuskError, clampText } from '@husk-ai/core';
import type { Computer, DirEntry } from '@husk-ai/core';
import { defineTool } from '../types.js';
import type { AgentTool, AgentToolContext } from '../types.js';
import { bool, int, object, shellQuote, str } from './util.js';

const DEFAULT_READ_BYTES = 128 * 1024;
const NUL = String.fromCharCode(0);

function cap(ctx: AgentToolContext, requested?: number): number {
  const ceiling = Math.max(1024, ctx.maxOutputBytes);
  if (requested === undefined) return Math.min(DEFAULT_READ_BYTES, ceiling);
  return Math.min(Math.max(1, requested), ceiling);
}

export interface ReadFileResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export const read_file = defineTool<
  { path: string; startLine?: number; endLine?: number; maxBytes?: number },
  ReadFileResult
>({
  name: 'read_file',
  description:
    'Read a text file from the computer. Supply startLine/endLine (1-based, inclusive) to read part of a large file. ' +
    'Output is capped; the cap is reported back so you know when you have only seen part of it.',
  needsComputer: true,
  parameters: object(
    {
      path: str('Absolute path inside the computer, e.g. /work/src/index.ts.'),
      startLine: int('First line to return, 1-based and inclusive.', { minimum: 1 }),
      endLine: int('Last line to return, 1-based and inclusive.', { minimum: 1 }),
      maxBytes: int('Byte ceiling for this read.', { minimum: 1 }),
    },
    ['path'],
  ),
  async handler(input, ctx) {
    const computer = await ctx.acquireComputer();
    const limit = cap(ctx, input.maxBytes);
    const raw = await computer.readTextFile(input.path, limit);
    const lines = raw.split('\n');
    const total = lines.length;

    const start = Math.max(1, input.startLine ?? 1);
    const end = Math.min(total, input.endLine ?? total);
    if (start > total) {
      throw new HuskError('E_TOOL_ERROR', `${input.path} has ${total} lines; startLine ${start} is past the end`, {
        hint: 'read the file without a range first to see how long it is',
      });
    }
    const slice = lines.slice(start - 1, Math.max(start, end)).join('\n');
    const clamped = clampText(slice, limit);
    return {
      path: input.path,
      content: clamped.text,
      startLine: start,
      endLine: Math.max(start, end),
      totalLines: total,
      truncated: clamped.truncated || Buffer.byteLength(raw, 'utf8') >= limit,
    };
  },
  render(out) {
    const header =
      out.startLine === 1 && out.endLine === out.totalLines
        ? `${out.path} (${out.totalLines} lines)`
        : `${out.path} lines ${out.startLine}-${out.endLine} of ${out.totalLines}`;
    return `${header}${out.truncated ? ' [truncated]' : ''}\n${out.content}`;
  },
});

export const write_file = defineTool<
  { path: string; content: string; append?: boolean; mode?: string },
  { path: string; bytes: number; append: boolean }
>({
  name: 'write_file',
  description:
    'Create or overwrite a text file on the computer. Parent directories are created. ' +
    'To change part of an existing file, prefer edit_file so you do not clobber work you have not read.',
  dangerous: true,
  needsComputer: true,
  parameters: object(
    {
      path: str('Absolute path inside the computer.'),
      content: str('Full file contents to write.'),
      append: bool('Append instead of replacing.'),
      mode: str('Octal permission string, e.g. "0755".'),
    },
    ['path', 'content'],
  ),
  async handler(input, ctx) {
    const computer = await ctx.acquireComputer();
    await computer.writeFile(input.path, input.content, {
      append: input.append ?? false,
      mkdirp: true,
      mode: input.mode,
    });
    return { path: input.path, bytes: Buffer.byteLength(input.content, 'utf8'), append: input.append ?? false };
  },
  render(out) {
    return `${out.append ? 'appended' : 'wrote'} ${out.bytes} bytes to ${out.path}`;
  },
});

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

export const edit_file = defineTool<
  { path: string; oldString: string; newString: string; replaceAll?: boolean },
  { path: string; replacements: number }
>({
  name: 'edit_file',
  description:
    'Replace an exact string in a file. oldString must appear exactly once unless replaceAll is true. ' +
    'Include enough surrounding context to make the match unique. A miss is an error, never a silent no-op.',
  dangerous: true,
  needsComputer: true,
  parameters: object(
    {
      path: str('Absolute path inside the computer.'),
      oldString: str('Exact text to find, including indentation and newlines.'),
      newString: str('Replacement text. Use an empty string to delete.'),
      replaceAll: bool('Replace every occurrence instead of requiring exactly one.'),
    },
    ['path', 'oldString', 'newString'],
  ),
  async handler(input, ctx) {
    if (input.oldString === input.newString) {
      throw new HuskError('E_TOOL_ERROR', 'oldString and newString are identical, so this edit would do nothing', {
        hint: 'pass the text you actually want to end up with',
      });
    }
    const computer = await ctx.acquireComputer();
    const before = await computer.readTextFile(input.path, 8 * 1024 * 1024);
    const hits = countOccurrences(before, input.oldString);

    if (hits === 0) {
      throw new HuskError('E_TOOL_ERROR', `oldString does not appear in ${input.path}`, {
        hint: 'read the file and copy the exact text, including whitespace and indentation',
        details: { path: input.path, oldStringPreview: input.oldString.slice(0, 200) },
      });
    }
    if (hits > 1 && !input.replaceAll) {
      throw new HuskError(
        'E_TOOL_ERROR',
        `oldString appears ${hits} times in ${input.path}, so the edit is ambiguous`,
        {
          hint: 'add surrounding lines until the match is unique, or set replaceAll to true',
          details: { path: input.path, occurrences: hits },
        },
      );
    }

    const after = input.replaceAll
      ? before.split(input.oldString).join(input.newString)
      : before.replace(input.oldString, input.newString);

    await computer.writeFile(input.path, after, { mkdirp: false });
    return { path: input.path, replacements: input.replaceAll ? hits : 1 };
  },
  render(out) {
    return `edited ${out.path} (${out.replacements} replacement${out.replacements === 1 ? '' : 's'})`;
  },
});

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
]);

export const list_dir = defineTool<
  { path: string; recursive?: boolean; limit?: number },
  { path: string; entries: DirEntry[]; truncated: boolean }
>({
  name: 'list_dir',
  description: 'List a directory on the computer. Set recursive to walk subdirectories, bounded by limit.',
  needsComputer: true,
  parameters: object(
    {
      path: str('Absolute directory path inside the computer.'),
      recursive: bool('Walk subdirectories too.'),
      limit: int('Maximum entries to return. Defaults to 500.', { minimum: 1, maximum: 5000 }),
    },
    ['path'],
  ),
  async handler(input, ctx) {
    const computer = await ctx.acquireComputer();
    const limit = input.limit ?? 500;
    if (!input.recursive) {
      const entries = await computer.listDir(input.path);
      return { path: input.path, entries: entries.slice(0, limit), truncated: entries.length > limit };
    }

    const out: DirEntry[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: input.path, depth: 0 }];
    let truncated = false;
    while (queue.length) {
      const next = queue.shift()!;
      if (next.depth > 12) continue;
      let entries: DirEntry[];
      try {
        entries = await computer.listDir(next.path);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (out.length >= limit) {
          truncated = true;
          break;
        }
        out.push(e);
        if (e.type === 'dir' && !SKIP_DIRS.has(e.name)) queue.push({ path: e.path, depth: next.depth + 1 });
      }
      if (truncated) break;
    }
    return { path: input.path, entries: out, truncated };
  },
  render(out) {
    if (!out.entries.length) return `${out.path} is empty`;
    const rows = out.entries.map((e) => `${e.type === 'dir' ? 'd' : '-'} ${String(e.size).padStart(9)}  ${e.path}`);
    return `${out.path}${out.truncated ? ' [truncated]' : ''}\n${rows.join('\n')}`;
  },
});

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export const search_files = defineTool<
  { pattern: string; path?: string; glob?: string; maxResults?: number; ignoreCase?: boolean },
  { pattern: string; engine: 'ripgrep' | 'walk'; hits: SearchHit[]; truncated: boolean }
>({
  name: 'search_files',
  description:
    'Search file contents for a regular expression. Uses ripgrep when the computer has it and falls back to a ' +
    'bounded scan otherwise, so results are always capped rather than unbounded.',
  needsComputer: true,
  parameters: object(
    {
      pattern: str('Regular expression to search for.'),
      path: str('Directory to search. Defaults to the husk workdir.'),
      glob: str('Restrict to files matching this glob, e.g. "*.ts".'),
      maxResults: int('Maximum matching lines to return. Defaults to 100.', { minimum: 1, maximum: 1000 }),
      ignoreCase: bool('Case-insensitive match.'),
    },
    ['pattern'],
  ),
  async handler(input, ctx) {
    const computer = await ctx.acquireComputer();
    const root = input.path ?? computer.info.workdir ?? '/work';
    const max = input.maxResults ?? 100;

    if (await hasRipgrep(computer, ctx)) {
      const argv = ['rg', '--line-number', '--no-heading', '--color', 'never', '--max-count', String(max)];
      if (input.ignoreCase) argv.push('--ignore-case');
      if (input.glob) argv.push('--glob', input.glob);
      argv.push('--regexp', input.pattern, root);

      const res = await computer.exec({
        cmd: shellQuote(argv),
        timeoutSec: Math.min(60, ctx.spec.limits.execTimeoutSec),
        maxOutputBytes: ctx.maxOutputBytes,
        signal: ctx.signal,
      });
      // rg exits 1 when it simply found nothing. That is not an error.
      if (res.exitCode > 1) {
        throw new HuskError('E_TOOL_ERROR', `search failed: ${res.stderr.trim() || `rg exited ${res.exitCode}`}`, {
          hint: 'check the regular expression, or narrow the path',
        });
      }
      const hits = parseRipgrep(res.stdout, max);
      return { pattern: input.pattern, engine: 'ripgrep', hits, truncated: hits.length >= max || res.truncated };
    }

    const walked = await walkSearch(computer, root, input.pattern, {
      max,
      glob: input.glob,
      ignoreCase: input.ignoreCase ?? false,
    });
    return { pattern: input.pattern, engine: 'walk', hits: walked.hits, truncated: walked.truncated };
  },
  render(out) {
    if (!out.hits.length) return `no matches for /${out.pattern}/`;
    const rows = out.hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
    const n = out.hits.length;
    return `${n} match${n === 1 ? '' : 'es'}${out.truncated ? ' (truncated)' : ''}\n${rows.join('\n')}`;
  },
});

async function hasRipgrep(computer: Computer, ctx: AgentToolContext): Promise<boolean> {
  const cached = ctx.state.get('husk.hasRipgrep');
  if (typeof cached === 'boolean') return cached;
  let found = false;
  try {
    const res = await computer.exec({
      cmd: 'command -v rg >/dev/null 2>&1 && echo yes || echo no',
      timeoutSec: 10,
      maxOutputBytes: 1024,
      signal: ctx.signal,
    });
    found = res.stdout.trim() === 'yes';
  } catch {
    found = false;
  }
  ctx.state.set('husk.hasRipgrep', found);
  return found;
}

function parseRipgrep(stdout: string, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    if (hits.length >= max) break;
    const m = /^(.*?):(\d+):([\s\S]*)$/.exec(line);
    if (!m) continue;
    hits.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 400) });
  }
  return hits;
}

const GLOB_SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/** Single-`*` segment globs, plus `**` for any depth. Enough for one tool argument. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += GLOB_SPECIAL.has(c) ? '\\' + c : c;
  }
  return new RegExp('^' + out + '$');
}

const WALK_MAX_FILES = 400;
const WALK_MAX_FILE_BYTES = 256 * 1024;

async function walkSearch(
  computer: Computer,
  root: string,
  pattern: string,
  opts: { max: number; glob?: string; ignoreCase: boolean },
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.ignoreCase ? 'i' : '');
  } catch (err) {
    throw new HuskError('E_TOOL_ERROR', `not a valid regular expression: ${(err as Error).message}`, {
      hint: 'escape any literal parentheses, brackets or backslashes',
    });
  }
  const globRe = opts.glob ? globToRegExp(opts.glob) : undefined;

  const hits: SearchHit[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let filesRead = 0;

  while (queue.length) {
    const next = queue.shift()!;
    if (next.depth > 10) continue;
    let entries: DirEntry[];
    try {
      entries = await computer.listDir(next.path);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (hits.length >= opts.max || filesRead >= WALK_MAX_FILES) return { hits, truncated: true };
      if (e.type === 'dir') {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push({ path: e.path, depth: next.depth + 1 });
        continue;
      }
      if (e.type !== 'file') continue;
      if (e.size > WALK_MAX_FILE_BYTES) continue;
      if (globRe && !globRe.test(e.name) && !globRe.test(e.path)) continue;

      filesRead += 1;
      let text: string;
      try {
        text = await computer.readTextFile(e.path, WALK_MAX_FILE_BYTES);
      } catch {
        continue;
      }
      if (text.includes(NUL)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        re.lastIndex = 0;
        if (!re.test(line)) continue;
        hits.push({ path: e.path, line: i + 1, text: line.slice(0, 400) });
        if (hits.length >= opts.max) return { hits, truncated: true };
      }
    }
  }
  return { hits, truncated: false };
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export const move = defineTool<{ from: string; to: string }, { from: string; to: string }>({
  name: 'move',
  description: 'Move or rename a file or directory on the computer.',
  dangerous: true,
  needsComputer: true,
  parameters: object({ from: str('Existing absolute path.'), to: str('New absolute path.') }, ['from', 'to']),
  async handler(input, ctx) {
    const computer = await ctx.acquireComputer();
    const existing = await computer.stat(input.from);
    if (!existing) {
      throw new HuskError('E_TOOL_ERROR', `nothing to move at ${input.from}`, {
        hint: 'list the directory first to confirm the path',
      });
    }
    const cmd =
      shellQuote(['mkdir', '-p', parentOf(input.to)]) + ' && ' + shellQuote(['mv', '--', input.from, input.to]);
    const res = await computer.exec({ cmd, timeoutSec: 60, maxOutputBytes: 8192, signal: ctx.signal });
    if (res.exitCode !== 0) {
      throw new HuskError('E_TOOL_ERROR', `move failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`, {
        hint: 'check that the destination directory is writable',
      });
    }
    return { from: input.from, to: input.to };
  },
  render(out) {
    return `moved ${out.from} to ${out.to}`;
  },
});

export const remove = defineTool<{ path: string; recursive?: boolean }, { path: string; recursive: boolean }>({
  name: 'delete',
  description: 'Delete a file, or a directory when recursive is true. There is no undo.',
  dangerous: true,
  needsComputer: true,
  parameters: object(
    { path: str('Absolute path inside the computer.'), recursive: bool('Required to delete a directory.') },
    ['path'],
  ),
  async handler(input, ctx) {
    const computer = await ctx.acquireComputer();
    const existing = await computer.stat(input.path);
    if (!existing) {
      throw new HuskError('E_TOOL_ERROR', `nothing to delete at ${input.path}`, {
        hint: 'list the directory first to confirm the path',
      });
    }
    if (existing.type === 'dir' && !input.recursive) {
      throw new HuskError('E_TOOL_ERROR', `${input.path} is a directory`, {
        hint: 'pass recursive: true if you really mean to delete it and everything inside',
      });
    }
    await computer.remove(input.path, { recursive: input.recursive ?? false });
    return { path: input.path, recursive: input.recursive ?? false };
  },
  render(out) {
    return `deleted ${out.path}`;
  },
});

export const fileTools: AgentTool[] = [read_file, write_file, edit_file, list_dir, search_files, move, remove];
