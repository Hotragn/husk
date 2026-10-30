import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { paths } from '@husk-ai/core';
import lockfile from 'proper-lockfile';
import { zipSync } from 'fflate';
import { WorkspaceError } from './errors.js';
import { fetchPublicSource, publicUrl } from './fetch.js';
import type { WorkspaceFile, WorkspaceManifest, WorkspaceStoreOptions, WorkspaceSummary, SourceRecord } from './types.js';

const ID = /^ws_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCE_ID = /^src_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 100;
const JOURNAL = '.husk-workspace-transaction.json';

function invalid(message: string): never { throw new WorkspaceError('INVALID_INPUT', message); }
function missing(message: string): never { throw new WorkspaceError('NOT_FOUND', message, 404); }
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }

function validName(value: string): string {
  if (typeof value !== 'string') invalid('Give the workspace a name.');
  const name = value.trim().normalize('NFC');
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) invalid('Workspace names must contain 1–100 characters without control characters.');
  return name;
}

function safePath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 220) invalid('File paths must contain 1–220 characters.');
  const parts = value.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\\<>:"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
      || ['__proto__', 'prototype', 'constructor'].includes(part.toLowerCase())) {
      invalid('Use a relative file path with ordinary folder and file names.');
    }
  }
  return parts.join('/');
}

function outputPath(value: string): string {
  const path = safePath(value);
  return path.startsWith('outputs/') ? path : `outputs/${path}`;
}

function validateManifest(value: unknown, expectedId?: string): WorkspaceManifest {
  const fail = (): never => { throw new WorkspaceError('STORE_CORRUPT', 'The workspace manifest is invalid. Restore it from a backup before continuing.', 500); };
  if (!value || typeof value !== 'object') fail();
  const m = value as WorkspaceManifest;
  if (m.version !== 1 || !ID.test(m.id) || (expectedId && m.id !== expectedId)
    || typeof m.name !== 'string' || !m.name || m.name !== validName(m.name)
    || !validDate(m.createdAt) || !validDate(m.updatedAt) || !Array.isArray(m.sources) || !Array.isArray(m.files)
    || m.sources.length > MAX_ENTRIES || m.files.length > MAX_ENTRIES) fail();
  const knownSources = new Set<string>();
  const knownPaths = new Set<string>();
  for (const s of m.sources) {
    if (!s || !SOURCE_ID.test(s.id) || s.path !== `sources/${s.id}.txt` || knownSources.has(s.id)
      || ![s.url, s.finalUrl, s.title, s.excerpt, s.sha256, s.contentType].every((item) => typeof item === 'string')
      || !/^[0-9a-f]{64}$/.test(s.sha256) || !validDate(s.fetchedAt) || typeof s.truncated !== 'boolean') fail();
    knownSources.add(s.id);
    knownPaths.add(s.path.toLowerCase());
  }
  for (const file of m.files) {
    if (!file || typeof file.path !== 'string' || !file.path.startsWith('outputs/')) fail();
    try { safePath(file.path); } catch { fail(); }
    if (knownPaths.has(file.path.toLowerCase()) || !Number.isInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > MAX_FILE_BYTES
      || !validDate(file.updatedAt) || !Array.isArray(file.sourceIds)
      || file.sourceIds.some((id) => !knownSources.has(id))) fail();
    knownPaths.add(file.path.toLowerCase());
  }
  return m;
}

function validDate(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

/** Local text workspaces. All operations share a cross-process lock and mutations use a replayable journal. */
export class WorkspaceStore {
  readonly root: string;
  private readonly fetchSource: NonNullable<WorkspaceStoreOptions['fetchSource']>;
  private readonly lockGuard = new AsyncLocalStorage<() => void>();

  constructor(options: WorkspaceStoreOptions = {}) {
    this.root = resolve(options.root ?? join(paths().root, 'workspaces'));
    this.fetchSource = options.fetchSource ?? fetchPublicSource;
  }

  async list(): Promise<WorkspaceSummary[]> {
    return this.locked(async () => (await this.manifests()).map((m) => ({
      id: m.id, name: m.name, createdAt: m.createdAt, updatedAt: m.updatedAt,
      sourceCount: m.sources.length, fileCount: m.files.length,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async create(value: string): Promise<WorkspaceManifest> {
    const name = validName(value);
    return this.locked(async () => {
      if ((await this.manifests()).some((m) => m.name.toLowerCase() === name.toLowerCase())) {
        throw new WorkspaceError('CONFLICT', `A workspace named “${name}” already exists. Open it or choose another name.`, 409);
      }
      const now = new Date().toISOString();
      const manifest: WorkspaceManifest = { version: 1, id: `ws_${randomUUID()}`, name, createdAt: now, updatedAt: now, sources: [], files: [] };
      await this.commit(manifest);
      return manifest;
    });
  }

  async get(id: string): Promise<WorkspaceManifest> { return this.locked(() => this.load(id)); }

  async open(nameOrId: string): Promise<WorkspaceManifest> {
    const name = validName(nameOrId);
    return this.locked(async () => {
      if (ID.test(name)) return this.load(name);
      const found = (await this.manifests()).find((m) => m.name.toLowerCase() === name.toLowerCase());
      return found ?? missing(`No workspace named “${name}” was found.`);
    });
  }

  async read(id: string, path: string): Promise<{ path: string; content: string; sourceIds: string[] }> {
    safePath(path);
    return this.locked(async () => {
      const m = await this.load(id);
      const source = m.sources.find((s) => s.path === path);
      const file = m.files.find((f) => f.path === path);
      if (!source && !file) missing('That file is not part of this workspace.');
      const content = await this.readBounded(join(id, path));
      return { path, content, sourceIds: source ? [source.id] : file!.sourceIds };
    });
  }

  async write(id: string, value: string, content: string, sourceIds: string[] = []): Promise<WorkspaceFile> {
    const path = outputPath(value);
    if (typeof content !== 'string') invalid('File content must be text.');
    const sizeBytes = Buffer.byteLength(content);
    if (sizeBytes > MAX_FILE_BYTES) throw new WorkspaceError('LIMIT_EXCEEDED', 'Each output can contain up to 2 MiB of text.', 413);
    if (!Array.isArray(sourceIds) || sourceIds.some((sourceId) => typeof sourceId !== 'string')) invalid('Source references must be source IDs.');
    return this.locked(async () => {
      const m = await this.load(id);
      if (sourceIds.some((sourceId) => !m.sources.some((source) => source.id === sourceId))) invalid('An output can reference only sources saved in this workspace.');
      const existing = m.files.find((file) => file.path.toLowerCase() === path.toLowerCase());
      if (existing && existing.path !== path) throw new WorkspaceError('CONFLICT', `Use the existing file spelling: ${existing.path}`, 409);
      if (!existing && m.files.length >= MAX_ENTRIES) throw new WorkspaceError('LIMIT_EXCEEDED', 'A workspace can contain up to 100 output files.', 413);
      await this.checkQuota(m, sizeBytes - (existing?.sizeBytes ?? 0));
      const file: WorkspaceFile = { path, sizeBytes, updatedAt: new Date().toISOString(), sourceIds: [...new Set(sourceIds)] };
      m.files = [...m.files.filter((item) => item.path !== path), file];
      m.updatedAt = file.updatedAt;
      await this.commit(m, { path, content });
      return file;
    });
  }

  async addSource(id: string, value: string): Promise<{ source: SourceRecord; content: string }> {
    const url = publicUrl(value).href;
    await this.get(id);
    // Network waits never hold the store lock; deletion during a fetch is checked again below.
    const fetched = await this.fetchSource(url);
    const bytes = Buffer.byteLength(fetched.content);
    if (bytes > MAX_FILE_BYTES) throw new WorkspaceError('LIMIT_EXCEEDED', 'The extracted source is larger than 2 MiB.', 413);
    return this.locked(async () => {
      const m = await this.load(id);
      if (m.sources.length >= MAX_ENTRIES) throw new WorkspaceError('LIMIT_EXCEEDED', 'A workspace can contain up to 100 sources.', 413);
      await this.checkQuota(m, bytes);
      const sourceId = `src_${randomUUID()}`;
      const source: SourceRecord = {
        id: sourceId, url, finalUrl: fetched.finalUrl, title: fetched.title,
        fetchedAt: new Date().toISOString(), excerpt: fetched.content.slice(0, 500),
        sha256: createHash('sha256').update(fetched.content).digest('hex'),
        path: `sources/${sourceId}.txt`, truncated: fetched.truncated, contentType: fetched.contentType,
      };
      m.sources.push(source);
      m.updatedAt = source.fetchedAt;
      await this.commit(m, { path: source.path, content: fetched.content });
      return { source, content: fetched.content };
    });
  }

  async export(id: string): Promise<Buffer> {
    return this.locked(async () => {
      const m = await this.load(id);
      await this.checkQuota(m, 0);
      const files: Record<string, Uint8Array> = Object.create(null);
      files['manifest.json'] = Buffer.from(JSON.stringify(m, null, 2));
      for (const file of [...m.sources, ...m.files]) files[file.path] = Buffer.from(await this.readBounded(join(id, file.path)));
      // Stored ZIP avoids a long CPU pause while holding the lock; exports remain portable.
      return Buffer.from(zipSync(files, { level: 0 }));
    });
  }

  async remove(id: string, confirmName: string): Promise<void> {
    return this.locked(async () => {
      const m = await this.load(id);
      if (confirmName !== m.name) invalid('Type the full workspace name to confirm deletion.');
      const directory = await this.safeLocation(id);
      const tombstone = await this.safeLocation(`.deleted-${id}-${randomUUID()}`);
      await rename(directory, tombstone);
      await rm(tombstone, { recursive: true, force: true });
    });
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) invalid('The workspace root must be a real directory, not a link.');
    let compromised: Error | undefined;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.root, {
        lockfilePath: join(this.root, '.husk-workspaces.lock'), realpath: false,
        stale: 30_000, update: 5_000,
        retries: { retries: 100, minTimeout: 50, maxTimeout: 200, factor: 1.1 },
        onCompromised: (error) => { compromised = error; },
      });
    } catch (error) {
      if (code(error) === 'ELOCKED') throw new WorkspaceError('STORE_BUSY', 'The workspace is busy. Try again in a moment.', 409);
      throw error;
    }
    const guard = () => {
      if (compromised) throw new WorkspaceError('STORE_BUSY', 'The workspace lock was interrupted. Try again in a moment.', 409);
    };
    return this.lockGuard.run(guard, async () => {
      try {
        await this.recover();
        guard();
        return await action();
      } finally { await release(); }
    });
  }

  /** Reject links in every store-owned path component, including the final file. */
  private async safeLocation(path: string, createParents = false): Promise<string> {
    this.lockGuard.getStore()?.();
    const target = resolve(this.root, path);
    const rel = relative(this.root, target);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(this.root, rel) !== target) invalid('The path must stay inside the workspace.');
    const parts = rel.split(sep);
    let current = this.root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if (code(error) !== 'ENOENT') throw error;
        if (index < parts.length - 1 && createParents) {
          await mkdir(current, { mode: 0o700 });
          stat = await lstat(current);
        } else continue;
      }
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) invalid('Workspace paths cannot contain symbolic links or junctions.');
    }
    const canonicalRoot = await realpath(this.root);
    const parent = await realpath(dirname(target)).catch((error) => code(error) === 'ENOENT' ? undefined : Promise.reject(error));
    if (parent && parent !== canonicalRoot && !parent.startsWith(canonicalRoot + sep)) invalid('The path resolves outside the workspace.');
    return target;
  }

  private async atomic(path: string, content: string): Promise<void> {
    const target = await this.safeLocation(path, true);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      this.lockGuard.getStore()?.();
      await rename(temporary, target);
    }
    finally { await unlink(temporary).catch((error) => { if (code(error) !== 'ENOENT') throw error; }); }
  }

  private async readBounded(path: string, maxBytes = MAX_FILE_BYTES): Promise<string> {
    const location = await this.safeLocation(path);
    const handle = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes || stat.nlink > 1) invalid('Workspace files must be ordinary text files within the size limit.');
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  }

  private async load(id: string): Promise<WorkspaceManifest> {
    if (typeof id !== 'string' || !ID.test(id)) invalid('The workspace ID is invalid.');
    try { return validateManifest(JSON.parse(await this.readBounded(join(id, 'manifest.json'))), id); }
    catch (error) {
      if (code(error) === 'ENOENT') missing('This workspace could not be found.');
      if (error instanceof SyntaxError) throw new WorkspaceError('STORE_CORRUPT', 'The workspace manifest could not be read. Restore it from a backup.', 500);
      throw error;
    }
  }

  private async manifests(): Promise<WorkspaceManifest[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const result: WorkspaceManifest[] = [];
    for (const entry of entries) {
      if (!ID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) invalid('A workspace directory was replaced with a link.');
      result.push(await this.load(entry.name));
    }
    return result;
  }

  private async checkQuota(m: WorkspaceManifest, additionalBytes: number): Promise<void> {
    let bytes = m.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    for (const source of m.sources) bytes += Buffer.byteLength(await this.readBounded(join(m.id, source.path)));
    if (bytes + additionalBytes > MAX_WORKSPACE_BYTES) throw new WorkspaceError('LIMIT_EXCEEDED', 'A workspace can contain up to 32 MiB of saved text.', 413);
  }

  private async commit(manifest: WorkspaceManifest, file?: { path: string; content: string }): Promise<void> {
    // Catch user-created links and directory/file conflicts before writing a
    // journal that could otherwise block every subsequent operation on replay.
    for (const path of [join(manifest.id, 'manifest.json'), ...(file ? [join(manifest.id, file.path)] : [])]) {
      const target = await this.safeLocation(path, true);
      const stat = await lstat(target).catch((error) => code(error) === 'ENOENT' ? undefined : Promise.reject(error));
      if (stat && (!stat.isFile() || stat.nlink > 1)) invalid('An output cannot replace a directory or linked file.');
    }
    // The journal is flushed before replacing either content or manifest. A crash
    // between the two renames replays the same complete mutation on next access.
    await this.atomic(JOURNAL, JSON.stringify({ manifest, file }));
    await this.apply(manifest, file);
    await unlink(await this.safeLocation(JOURNAL));
  }

  private async recover(): Promise<void> {
    let text: string;
    try { text = await this.readBounded(JOURNAL, MAX_FILE_BYTES * 7); }
    catch (error) { if (code(error) === 'ENOENT') return; throw error; }
    let pending: { manifest: WorkspaceManifest; file?: { path: string; content: string } };
    try { pending = JSON.parse(text); } catch { throw new WorkspaceError('STORE_CORRUPT', 'The workspace recovery journal is damaged.', 500); }
    const manifest = validateManifest(pending.manifest);
    if (pending.file) {
      const file = pending.file;
      if (typeof file.content !== 'string' || Buffer.byteLength(file.content) > MAX_FILE_BYTES
        || ![...manifest.sources, ...manifest.files].some((entry) => entry.path === file.path)) {
        throw new WorkspaceError('STORE_CORRUPT', 'The workspace recovery journal contains an invalid file.', 500);
      }
      safePath(file.path);
    }
    await this.apply(manifest, pending.file);
    await unlink(await this.safeLocation(JOURNAL));
  }

  private async apply(manifest: WorkspaceManifest, file?: { path: string; content: string }): Promise<void> {
    if (file) await this.atomic(join(manifest.id, file.path), file.content);
    await this.atomic(join(manifest.id, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
}
