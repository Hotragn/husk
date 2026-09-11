import { describe, expect, it } from 'vitest';
import type { Computer, DirEntry } from '@husk/core';
import { isBinary, listWorkResources, mimeTypeFor, pathForUri, readWorkResource, uriFor } from './resources.js';

/**
 * A computer whose filesystem is a flat map of paths.
 *
 * `listDir` answers for one level, the way a real provider does, so the walk in
 * `listWorkResources` is exercised rather than mocked out.
 */
function fakeComputer(files: Record<string, string | Uint8Array>): Computer {
  const paths = Object.keys(files);

  const entriesIn = (dir: string): DirEntry[] => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const seen = new Map<string, DirEntry>();
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const body = files[path]!;
        seen.set(rest, {
          name: rest,
          path,
          type: 'file',
          size: typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength,
        });
      } else {
        const name = rest.slice(0, slash);
        seen.set(name, { name, path: `${prefix}${name}`, type: 'dir', size: 0 });
      }
    }
    return [...seen.values()];
  };

  return {
    id: 'cmp_fake',
    info: { id: 'cmp_fake', provider: 'docker' },
    async listDir(dir: string) {
      return entriesIn(dir);
    },
    async stat(path: string) {
      const body = files[path];
      if (body !== undefined) {
        return {
          name: path,
          path,
          type: 'file' as const,
          size: typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength,
        };
      }
      return paths.some((p) => p.startsWith(`${path}/`))
        ? { name: path, path, type: 'dir' as const, size: 0 }
        : null;
    },
    async readTextFile(path: string) {
      const body = files[path];
      if (body === undefined) throw new Error(`no such file: ${path}`);
      return typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
    },
    async readFile(path: string) {
      const body = files[path];
      if (body === undefined) throw new Error(`no such file: ${path}`);
      return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    },
  } as unknown as Computer;
}

describe('uriFor / pathForUri', () => {
  it('round-trips a path under /work', () => {
    expect(pathForUri(uriFor('/work/report.md'))).toBe('/work/report.md');
    expect(pathForUri(uriFor('/work/out/chart.png'))).toBe('/work/out/chart.png');
  });

  it('round-trips a name that needs escaping', () => {
    const path = '/work/quarterly report (final).md';
    expect(uriFor(path)).not.toContain(' ');
    expect(pathForUri(uriFor(path))).toBe(path);
  });

  it('refuses a traversal', () => {
    expect(() => pathForUri('husk://work/../../etc/passwd')).toThrowError(/escapes \/work/);
  });

  it('refuses a percent-encoded traversal, which normalising alone would resolve', () => {
    expect(() => pathForUri('husk://work/%2e%2e/%2e%2e/etc/passwd')).toThrowError(/escapes \/work/);
  });

  it('refuses a URI that is not a husk work resource', () => {
    expect(() => pathForUri('file:///etc/passwd')).toThrowError(/not a husk work resource/);
    expect(() => pathForUri('husk://other/thing')).toThrowError(/not a husk work resource/);
  });
});

describe('mimeTypeFor', () => {
  it('recognises the types a client would render', () => {
    expect(mimeTypeFor('/work/a.png')).toBe('image/png');
    expect(mimeTypeFor('/work/a.md')).toBe('text/markdown');
    expect(mimeTypeFor('/work/a.json')).toBe('application/json');
  });

  it('treats an unknown extension as text, which is the safe default for both paths', () => {
    expect(mimeTypeFor('/work/Makefile')).toBe('text/plain');
    expect(mimeTypeFor('/work/a.unheardof')).toBe('text/plain');
  });

  it('sends structured text as text and everything else as a blob', () => {
    expect(isBinary('text/markdown')).toBe(false);
    expect(isBinary('application/json')).toBe(false);
    expect(isBinary('application/yaml')).toBe(false);
    expect(isBinary('image/png')).toBe(true);
    expect(isBinary('application/pdf')).toBe(true);
  });
});

describe('listWorkResources', () => {
  it('lists files with their type and size', async () => {
    const c = fakeComputer({ '/work/report.md': '# hello' });
    expect(await listWorkResources(c)).toEqual([
      { uri: 'husk://work/report.md', name: 'report.md', mimeType: 'text/markdown', size: 7 },
    ]);
  });

  it('walks into subdirectories and names entries relative to /work', async () => {
    const c = fakeComputer({ '/work/out/chart.png': 'x', '/work/top.txt': 'y' });
    expect((await listWorkResources(c)).map((r) => r.name)).toEqual(['out/chart.png', 'top.txt']);
  });

  it('skips directories that are never anyone deliverable', async () => {
    const c = fakeComputer({
      '/work/node_modules/left-pad/index.js': 'x',
      '/work/.git/HEAD': 'x',
      '/work/answer.txt': 'x',
    });
    expect((await listWorkResources(c)).map((r) => r.name)).toEqual(['answer.txt']);
  });

  it('survives a directory it cannot read', async () => {
    const c = fakeComputer({ '/work/ok.txt': 'x' });
    const broken = {
      ...c,
      async listDir(dir: string) {
        if (dir !== '/work') throw new Error('permission denied');
        return c.listDir(dir);
      },
    } as unknown as Computer;
    expect((await listWorkResources(broken)).map((r) => r.name)).toEqual(['ok.txt']);
  });
});

describe('readWorkResource', () => {
  it('returns text for a text file', async () => {
    const c = fakeComputer({ '/work/report.md': '# hello' });
    expect(await readWorkResource(c, 'husk://work/report.md')).toEqual({
      uri: 'husk://work/report.md',
      mimeType: 'text/markdown',
      text: '# hello',
    });
  });

  it('returns base64 for a binary file, so a client can render or download it', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const c = fakeComputer({ '/work/chart.png': png });
    const out = await readWorkResource(c, 'husk://work/chart.png');
    expect(out.text).toBeUndefined();
    expect(out.mimeType).toBe('image/png');
    expect(Buffer.from(out.blob as string, 'base64')).toEqual(Buffer.from(png));
  });

  it('refuses a directory with something more useful than a read error', async () => {
    const c = fakeComputer({ '/work/out/chart.png': 'x' });
    await expect(readWorkResource(c, 'husk://work/out')).rejects.toThrowError(/is a directory/);
  });

  it('refuses a file over the resource ceiling instead of streaming it into a transcript', async () => {
    const c = fakeComputer({ '/work/huge.txt': 'x'.repeat(5 * 1024 * 1024) });
    await expect(readWorkResource(c, 'husk://work/huge.txt')).rejects.toThrowError(/over the .* resource limit/);
  });

  it('will not read outside /work even when asked directly', async () => {
    const c = fakeComputer({ '/work/ok.txt': 'x' });
    await expect(readWorkResource(c, 'husk://work/../../../etc/passwd')).rejects.toThrowError(/escapes \/work/);
  });
});
