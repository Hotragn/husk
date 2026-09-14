import { HuskError, createLogger } from '@husk/core';
import { describe, expect, it } from 'vitest';
import { FakeComputer, specFor } from '../test-support.js';
import type { AgentTool, AgentToolContext } from '../types.js';
import { edit_file, globToRegExp, list_dir, read_file, remove, search_files, write_file } from './files.js';

function contextFor(computer: FakeComputer): AgentToolContext {
  return {
    computer,
    log: createLogger({ level: 'silent' }),
    huskId: 'test-husk',
    runId: 'run_test',
    state: new Map(),
    emit: () => undefined,
    confirm: async () => false,
    acquireComputer: async () => computer,
    spec: specFor(),
    maxOutputBytes: 262_144,
    callId: 'call_test',
  };
}

async function call<O>(tool: AgentTool, input: Record<string, unknown>, computer: FakeComputer): Promise<O> {
  return (await tool.handler(input, contextFor(computer))) as O;
}

describe('edit_file', () => {
  const file = '/work/a.ts';

  it('replaces a unique match', async () => {
    const c = new FakeComputer({ files: { [file]: 'const a = 1;\nconst b = 2;\n' } });
    const out = await call<{ replacements: number }>(
      edit_file,
      { path: file, oldString: 'const b = 2;', newString: 'const b = 3;' },
      c,
    );
    expect(out.replacements).toBe(1);
    expect(c.files.get(file)).toBe('const a = 1;\nconst b = 3;\n');
  });

  it('fails loudly when the old string is absent, and does not write', async () => {
    const c = new FakeComputer({ files: { [file]: 'const a = 1;\n' } });
    await expect(
      call(edit_file, { path: file, oldString: 'const z = 9;', newString: 'x' }, c),
    ).rejects.toThrow(/does not appear/);
    expect(c.files.get(file)).toBe('const a = 1;\n');
  });

  it('fails loudly when the old string is ambiguous, and does not write', async () => {
    const c = new FakeComputer({ files: { [file]: 'x = 1;\nx = 1;\nx = 1;\n' } });
    const err = await call(edit_file, { path: file, oldString: 'x = 1;', newString: 'x = 2;' }, c).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HuskError);
    expect((err as HuskError).message).toContain('appears 3 times');
    expect((err as HuskError).hint).toContain('replaceAll');
    expect(c.files.get(file)).toBe('x = 1;\nx = 1;\nx = 1;\n');
  });

  it('replaces every occurrence when asked', async () => {
    const c = new FakeComputer({ files: { [file]: 'x = 1;\nx = 1;\n' } });
    const out = await call<{ replacements: number }>(
      edit_file,
      { path: file, oldString: 'x = 1;', newString: 'x = 2;', replaceAll: true },
      c,
    );
    expect(out.replacements).toBe(2);
    expect(c.files.get(file)).toBe('x = 2;\nx = 2;\n');
  });

  it('refuses a no-op edit rather than reporting success', async () => {
    const c = new FakeComputer({ files: { [file]: 'same' } });
    await expect(call(edit_file, { path: file, oldString: 'same', newString: 'same' }, c)).rejects.toThrow(
      /identical/,
    );
  });
});

describe('read_file', () => {
  const file = '/work/lines.txt';
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

  it('returns the whole file by default', async () => {
    const c = new FakeComputer({ files: { [file]: body } });
    const out = await call<{ content: string; totalLines: number }>(read_file, { path: file }, c);
    expect(out.totalLines).toBe(10);
    expect(out.content).toContain('line 10');
  });

  it('honours an inclusive line range', async () => {
    const c = new FakeComputer({ files: { [file]: body } });
    const out = await call<{ content: string; startLine: number; endLine: number }>(
      read_file,
      { path: file, startLine: 3, endLine: 5 },
      c,
    );
    expect(out.content).toBe('line 3\nline 4\nline 5');
    expect([out.startLine, out.endLine]).toEqual([3, 5]);
  });

  it('says so when the range starts past the end', async () => {
    const c = new FakeComputer({ files: { [file]: body } });
    await expect(call(read_file, { path: file, startLine: 99 }, c)).rejects.toThrow(/past the end/);
  });

  it('caps the read at the requested byte budget', async () => {
    const c = new FakeComputer({ files: { [file]: 'y'.repeat(10_000) } });
    const out = await call<{ content: string; truncated: boolean }>(read_file, { path: file, maxBytes: 1024 }, c);
    expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(1024);
    expect(out.truncated).toBe(true);
  });
});

describe('write_file', () => {
  it('writes and appends', async () => {
    const c = new FakeComputer();
    await call(write_file, { path: '/work/n.txt', content: 'a' }, c);
    await call(write_file, { path: '/work/n.txt', content: 'b', append: true }, c);
    expect(c.files.get('/work/n.txt')).toBe('ab');
  });
});

describe('list_dir', () => {
  it('lists one level, then walks when asked', async () => {
    const c = new FakeComputer({
      files: { '/work/a.txt': '1', '/work/sub/b.txt': '2', '/work/sub/deep/c.txt': '3' },
    });
    const flat = await call<{ entries: Array<{ name: string }> }>(list_dir, { path: '/work' }, c);
    expect(flat.entries.map((e) => e.name)).toEqual(['a.txt', 'sub']);

    const deep = await call<{ entries: Array<{ path: string }> }>(list_dir, { path: '/work', recursive: true }, c);
    expect(deep.entries.map((e) => e.path)).toContain('/work/sub/deep/c.txt');
  });
});

describe('search_files', () => {
  const files = {
    '/work/one.ts': 'const needle = 1;\nconst hay = 2;\n',
    '/work/two.ts': 'nothing here\n',
    '/work/sub/three.md': 'a needle in prose\n',
  };

  it('uses ripgrep when the machine has it', async () => {
    const c = new FakeComputer({
      files,
      exec: (req) => {
        const cmd = String(req.cmd);
        if (cmd.includes('command -v rg')) return { stdout: 'yes\n' };
        return { stdout: '/work/one.ts:1:const needle = 1;\n', exitCode: 0 };
      },
    });
    const out = await call<{ engine: string; hits: Array<{ path: string; line: number }> }>(
      search_files,
      { pattern: 'needle' },
      c,
    );
    expect(out.engine).toBe('ripgrep');
    expect(out.hits).toEqual([{ path: '/work/one.ts', line: 1, text: 'const needle = 1;' }]);
  });

  it('treats a ripgrep exit code of 1 as "no matches", not a failure', async () => {
    const c = new FakeComputer({
      files,
      exec: (req) => (String(req.cmd).includes('command -v rg') ? { stdout: 'yes\n' } : { exitCode: 1, stdout: '' }),
    });
    const out = await call<{ hits: unknown[] }>(search_files, { pattern: 'zzz' }, c);
    expect(out.hits).toEqual([]);
  });

  it('falls back to a bounded walk when ripgrep is missing', async () => {
    const c = new FakeComputer({ files, exec: () => ({ stdout: 'no\n' }) });
    const out = await call<{ engine: string; hits: Array<{ path: string }> }>(search_files, { pattern: 'needle' }, c);
    expect(out.engine).toBe('walk');
    expect(out.hits.map((h) => h.path).sort()).toEqual(['/work/one.ts', '/work/sub/three.md']);
  });

  it('honours a glob in the walk fallback', async () => {
    const c = new FakeComputer({ files, exec: () => ({ stdout: 'no\n' }) });
    const out = await call<{ hits: Array<{ path: string }> }>(
      search_files,
      { pattern: 'needle', glob: '*.ts' },
      c,
    );
    expect(out.hits.map((h) => h.path)).toEqual(['/work/one.ts']);
  });

  it('reports a bad regex instead of crashing', async () => {
    const c = new FakeComputer({ files, exec: () => ({ stdout: 'no\n' }) });
    await expect(call(search_files, { pattern: '([' }, c)).rejects.toThrow(/regular expression/);
  });

  it('caps the number of hits', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) many[`/work/f${i}.txt`] = 'needle\nneedle\n';
    const c = new FakeComputer({ files: many, exec: () => ({ stdout: 'no\n' }) });
    const out = await call<{ hits: unknown[]; truncated: boolean }>(
      search_files,
      { pattern: 'needle', maxResults: 5 },
      c,
    );
    expect(out.hits).toHaveLength(5);
    expect(out.truncated).toBe(true);
  });
});

describe('delete', () => {
  it('refuses a directory unless recursive is set', async () => {
    const c = new FakeComputer({ files: { '/work/d/x.txt': '1' } });
    await expect(call(remove, { path: '/work/d' }, c)).rejects.toThrow(/is a directory/);
    await call(remove, { path: '/work/d', recursive: true }, c);
    expect(c.files.size).toBe(0);
  });

  it('says so when there is nothing there', async () => {
    const c = new FakeComputer();
    await expect(call(remove, { path: '/work/ghost' }, c)).rejects.toThrow(/nothing to delete/);
  });
});

describe('globToRegExp', () => {
  it('keeps a single star inside one path segment', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('sub/a.ts')).toBe(false);
    expect(globToRegExp('**/*.ts').test('sub/a.ts')).toBe(true);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});
