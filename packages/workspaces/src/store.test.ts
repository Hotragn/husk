import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { WorkspaceStore, WorkspaceError } from './index.js';

const roots: string[] = [];
// Workspace-local fixtures also run inside Windows app containers, whose OS
// temp directory cannot always be resolved with realpath.
const fixtureRoot = fileURLToPath(new URL('../test-results/', import.meta.url));
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function store() {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'husk-workspace-test-'));
  roots.push(root);
  return new WorkspaceStore({ root, fetchSource: async (url) => ({
    finalUrl: `${url}?final=1`, title: 'Saved source', content: 'A factual source.\nSecond line.',
    contentType: 'text/plain', truncated: false,
  }) });
}

describe('durable task workspaces', () => {
  it('reopens sources and output in a new instance and exports the exact saved material', async () => {
    const first = await store();
    const workspace = await first.create('Travel research');
    const { source } = await first.addSource(workspace.id, 'https://example.com/article');
    const file = await first.write(workspace.id, 'brief.md', '# A brief', [source.id]);
    const second = new WorkspaceStore({ root: first.root });
    const reopened = await second.open('TRAVEL RESEARCH');
    expect(reopened.sources[0]).toMatchObject({ id: source.id, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await second.read(workspace.id, file.path)).toEqual({ path: 'outputs/brief.md', content: '# A brief', sourceIds: [source.id] });
    const archive = unzipSync(await second.export(workspace.id));
    expect(strFromU8(archive['outputs/brief.md']!)).toBe('# A brief');
    expect(strFromU8(archive[source.path]!)).toContain('A factual source.');
    expect(JSON.parse(strFromU8(archive['manifest.json']!))).toEqual(reopened);
    expect(await second.list()).toEqual([expect.objectContaining({ sourceCount: 1, fileCount: 1, name: 'Travel research' })]);
  });

  it('serializes writers and case-insensitive name creation across store instances', async () => {
    const first = await store();
    const second = new WorkspaceStore({ root: first.root });
    const creates = await Promise.allSettled([first.create('Brief'), second.create('brief')]);
    expect(creates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const workspace = await first.open('brief');
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).write(workspace.id, `part-${i}.md`, `part ${i}`)));
    expect((await second.get(workspace.id)).files).toHaveLength(12);
  });

  it('replays a pending content and manifest mutation after an interrupted process', async () => {
    const first = await store();
    const workspace = await first.create('Recovery');
    await first.write(workspace.id, 'draft.md', 'Before');
    const manifest = await first.get(workspace.id);
    manifest.files[0]!.sizeBytes = 5;
    await writeFile(join(first.root, '.husk-workspace-transaction.json'), JSON.stringify({ manifest, file: { path: 'outputs/draft.md', content: 'After' } }));
    const recovered = new WorkspaceStore({ root: first.root });
    expect((await recovered.read(workspace.id, 'outputs/draft.md')).content).toBe('After');
    expect((await recovered.get(workspace.id)).files[0]!.sizeBytes).toBe(5);
    await expect(readFile(join(first.root, '.husk-workspace-transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['../secret', '/absolute', 'C:/secret', 'a\\b', 'CON.txt', 'dir/aux', 'prototype/a', '__proto__', 'a/constructor', 'file.', 'file ', 'a//b', 'outputs/../manifest.json'])('refuses unsafe output path %s', async (path) => {
    const first = await store();
    const workspace = await first.create('Paths');
    await expect(first.write(workspace.id, path, 'escape')).rejects.toBeInstanceOf(WorkspaceError);
    expect((await first.get(workspace.id)).files).toHaveLength(0);
  });

  it('refuses junctions in output folders', async () => {
    const first = await store();
    const workspace = await first.create('Links');
    const outside = await mkdtemp(join(fixtureRoot, 'husk-workspace-outside-'));
    roots.push(outside);
    await mkdir(join(first.root, workspace.id, 'outputs'));
    await symlink(outside, join(first.root, workspace.id, 'outputs', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(first.write(workspace.id, 'linked/escape.md', 'escape')).rejects.toThrow(/links|junctions/);
    await expect(readFile(join(outside, 'escape.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates source references, file size, file casing and explicit delete confirmation', async () => {
    const first = await store();
    const workspace = await first.create('Keep me');
    await expect(first.write(workspace.id, 'draft.md', '', ['missing'])).rejects.toThrow(/only sources/);
    await expect(first.write(workspace.id, 'large.md', 'x'.repeat(2 * 1024 * 1024 + 1))).rejects.toMatchObject({ statusCode: 413 });
    await first.write(workspace.id, 'draft.md', 'saved');
    await expect(first.write(workspace.id, 'DRAFT.md', 'bad')).rejects.toMatchObject({ statusCode: 409 });
    await expect(first.remove(workspace.id, 'keep me')).rejects.toThrow(/full workspace name/);
    await first.remove(workspace.id, 'Keep me');
    await expect(first.get(workspace.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('does not save failed source captures or list local provider directories', async () => {
    const first = await store();
    await mkdir(join(first.root, 'computer-existing'));
    const workspace = await first.create('Sources');
    const failed = new WorkspaceStore({ root: first.root, fetchSource: async () => { throw new Error('Offline'); } });
    await expect(failed.addSource(workspace.id, 'https://example.com')).rejects.toThrow('Offline');
    expect((await first.list())[0]!.sourceCount).toBe(0);
    expect(await first.list()).toHaveLength(1);
  });
});
