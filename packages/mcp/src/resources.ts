import { posix } from 'node:path';
import type { Computer, DirEntry } from '@husk/core';
import { HuskError } from '@husk/core';

/**
 * The files in `/work`, as MCP resources.
 *
 * Tools let a model *drive* the computer. Resources are the only way husk can
 * let a person *see* it: a tool result is text in a transcript, so a client has
 * nothing to render a chart with, nothing to attach, nothing to download. The
 * MCP server advertised `capabilities: { tools: {} }` and no resource handlers,
 * which meant "show me what the bot made" had no answer that was not a wall of
 * pasted characters.
 *
 * Scope is deliberately `/work` and nothing else. It is the directory that
 * persists, it is the one the agent is told to use, and anything wider would
 * make the resource list a filesystem browser for the whole machine -- which on
 * the `local` provider reaches a great deal more than the machine.
 */

export const RESOURCE_SCHEME = 'husk';
export const WORK_ROOT = '/work';

/** How many entries one `resources/list` may return. */
const MAX_ENTRIES = 500;
/** How deep to walk. `/work` holding a node_modules tree must not hang the list. */
const MAX_DEPTH = 6;
/** Read ceiling for one resource. */
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

/**
 * Extension to MIME type.
 *
 * Deliberately short. The purpose is not completeness; it is that a client can
 * tell "render this inline" from "offer a download", and getting `text/plain`
 * for an unknown extension is the right default for both.
 */
const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.py': 'text/x-python',
  '.svg': 'image/svg+xml',
  '.toml': 'application/toml',
  '.ts': 'text/typescript',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

/** Directories that are never anyone's deliverable. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', 'dist', '.mypy_cache']);

export function mimeTypeFor(path: string): string {
  return MIME[posix.extname(path).toLowerCase()] ?? 'text/plain';
}

/** True when the bytes are better handed over as a blob than as text. */
export function isBinary(mimeType: string): boolean {
  return !mimeType.startsWith('text/') && !/^application\/(json|toml|xml|yaml|x-ndjson)$/.test(mimeType);
}

export function uriFor(path: string): string {
  const rel = posix.relative(WORK_ROOT, path);
  return `${RESOURCE_SCHEME}://work/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Resolve a resource URI back to a path inside `/work`.
 *
 * This is the only place a client-supplied string becomes a path, so it is the
 * only place that can let one out of `/work`. `..` is rejected after decoding
 * and after normalising, because `%2e%2e` decodes into something normalisation
 * would otherwise happily resolve.
 */
export function pathForUri(uri: string): string {
  const prefix = `${RESOURCE_SCHEME}://work/`;
  if (!uri.startsWith(prefix)) {
    throw new HuskError('E_FS_DENIED', `not a husk work resource: ${uri}`, {
      hint: `resource URIs look like ${prefix}report.md`,
    });
  }
  const rel = uri.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
  const full = posix.normalize(posix.join(WORK_ROOT, rel));
  if (full !== WORK_ROOT && !full.startsWith(`${WORK_ROOT}/`)) {
    throw new HuskError('E_FS_DENIED', `resource path escapes ${WORK_ROOT}: ${uri}`, {
      hint: 'resources are scoped to /work',
    });
  }
  return full;
}

/**
 * Walk `/work` breadth-first and describe what is there.
 *
 * Breadth-first on purpose: when the walk is cut short by `MAX_ENTRIES`, what
 * survives is the top of the tree, which is where a deliverable actually is. A
 * depth-first walk truncated at 500 would return 500 files from inside one
 * directory and omit the report sitting at the root.
 */
export async function listWorkResources(computer: Computer): Promise<ResourceDescriptor[]> {
  const out: ResourceDescriptor[] = [];
  let frontier: Array<{ path: string; depth: number }> = [{ path: WORK_ROOT, depth: 0 }];

  while (frontier.length && out.length < MAX_ENTRIES) {
    const next: Array<{ path: string; depth: number }> = [];
    for (const dir of frontier) {
      if (out.length >= MAX_ENTRIES) break;
      let entries: DirEntry[];
      try {
        entries = await computer.listDir(dir.path);
      } catch {
        // A directory that vanished mid-walk, or one we cannot read. Listing is
        // a convenience; it must not fail the whole request.
        continue;
      }
      for (const entry of entries) {
        if (out.length >= MAX_ENTRIES) break;
        if (entry.type === 'dir') {
          if (dir.depth + 1 <= MAX_DEPTH && !SKIP_DIRS.has(entry.name)) {
            next.push({ path: entry.path, depth: dir.depth + 1 });
          }
          continue;
        }
        if (entry.type !== 'file') continue;
        const mimeType = mimeTypeFor(entry.path);
        out.push({
          uri: uriFor(entry.path),
          name: posix.relative(WORK_ROOT, entry.path) || entry.name,
          mimeType,
          size: entry.size,
          ...(entry.modifiedAt ? { description: `modified ${entry.modifiedAt}` } : {}),
        });
      }
    }
    frontier = next;
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
}

/** Read one resource, as text when it is text and base64 when it is not. */
export async function readWorkResource(computer: Computer, uri: string): Promise<ResourceContents> {
  const path = pathForUri(uri);
  const mimeType = mimeTypeFor(path);

  const stat = await computer.stat(path).catch(() => null);
  if (stat && stat.type === 'dir') {
    throw new HuskError('E_FS_DENIED', `${path} is a directory`, {
      hint: 'list resources to see the files inside it',
    });
  }
  if (stat && stat.size > MAX_RESOURCE_BYTES) {
    throw new HuskError('E_FS_DENIED', `${path} is ${stat.size} bytes, over the ${MAX_RESOURCE_BYTES} resource limit`, {
      hint: 'read it in pieces with read_file, or compress it first',
    });
  }

  if (isBinary(mimeType)) {
    const bytes = await computer.readFile(path);
    return { uri, mimeType, blob: Buffer.from(bytes).toString('base64') };
  }
  return { uri, mimeType, text: await computer.readTextFile(path, MAX_RESOURCE_BYTES) };
}
