/**
 * `fs/upload` and `fs/download`.
 *
 * Documented as "not implemented" since the first release, with the reason
 * given as the build contract: every usable tar on npm is a native module or a
 * large dependency. True, and beside the point -- the tar we need is already
 * inside the machine. What these assert is that the work happens *there*: the
 * archive is built and unpacked by the computer's own tar, the host only moves
 * bytes, and the scratch file is cleaned up on every path including failure.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestApp, FakeComputer } from '../testing.js';
import type { TestApp } from '../testing.js';
import type { ExecRequest, ExecResult } from '@husk-ai/core';
import { downloadScript } from './archive.js';

/**
 * A computer whose `tar` does something.
 *
 * `FakeComputer` answers every exec with "ran: <cmd>", which is enough for
 * routes that only care that a command was issued. These routes read back what
 * tar wrote, so the double has to honour the part of the contract they depend
 * on: the archive lands at the file `head` writes, and the script prints its
 * size, then tar's status when tar failed.
 */
class TarringComputer extends FakeComputer {
  /** The whole script's exit status: 66 is its "no such path". */
  failWith: number | null = null;
  /** tar's own status, kept aside by the script when tar fails part-way. */
  tarStatus: number | null = null;
  /** The size the script reports, as `head` cut it off. */
  archiveBytes: number | null = null;
  readonly commands: string[] = [];
  readonly reads: string[] = [];

  override async exec(req: ExecRequest): Promise<ExecResult> {
    const cmd = Array.isArray(req.cmd) ? req.cmd.join(' ') : req.cmd;
    this.commands.push(cmd);
    const result = (exitCode: number, stdout = '', stderr = ''): ExecResult => ({ exitCode, stdout, stderr, durationMs: 1, truncated: false, timedOut: false });

    const created = /tar -czf - .*\| head -c \d+ > '([^']+)'/.exec(cmd);
    if (created) {
      if (this.failWith !== null) return result(this.failWith, '', 'no such path: /nope');
      await this.writeFile(created[1]!, Buffer.from('PRETEND-TARBALL'));
      const size = this.archiveBytes ?? 'PRETEND-TARBALL'.length;
      return result(0, `${size}\n${this.tarStatus ?? ''}`, this.tarStatus ? 'tar: /work/secret: Cannot open: Permission denied' : '');
    }

    const removed = /rm -f '([^']+)'/.exec(cmd);
    if (removed) await this.remove(removed[1]!);

    return result(0);
  }

  override async readFile(path: string): Promise<Uint8Array> {
    this.reads.push(path);
    return super.readFile(path);
  }
}

describe('fs/download and fs/upload', () => {
  let ctx: TestApp;
  let computer: TarringComputer;

  beforeEach(async () => {
    ctx = await buildTestApp();
    computer = new TarringComputer('c1');
    ctx.manager.computers.set('c1', computer);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns the bytes the computer tarred, as a gzip attachment', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/work' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/gzip');
    expect(res.headers['content-disposition']).toContain('c1.tgz');
    expect(res.rawPayload.toString()).toBe('PRETEND-TARBALL');
  });

  it('tars relative to the parent, not from /', () => {
    // `tar -czf a.tgz /work` makes an archive that unpacks to ./work under
    // whatever directory it is opened in, with a warning about the stripped
    // slash. `-C parent base` is the shape that survives being moved.
    return ctx.app
      .inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/work/src' })
      .then(() => {
        const tar = computer.commands.find((c) => c.includes('tar -czf'))!;
        expect(tar).toContain('-C "$(dirname');
        expect(tar).toContain('"$(basename');
      });
  });

  it('deletes the staged archive afterwards', async () => {
    await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/work' });
    expect(computer.commands.some((c) => c.startsWith('rm -f'))).toBe(true);
    // And it is actually gone, not merely asked for.
    const scratch = /rm -f '([^']+)'/.exec(computer.commands.find((c) => c.startsWith('rm -f'))!)![1]!;
    await expect(computer.readFile(scratch)).rejects.toThrow();
  });

  it('deletes the staged archive when tar fails too', async () => {
    computer.failWith = 1;
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/work' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(computer.commands.some((c) => c.startsWith('rm -f'))).toBe(true);
  });

  it('says the path does not exist rather than reporting a tar failure', async () => {
    // 66 is the guard in the script, a status tar never returns, and the hint
    // should send someone to `ls` rather than to their tar installation.
    computer.failWith = 66;
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/nope' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('does not exist');
    // tar's own fatal status, 2, is not mistaken for it.
    computer.failWith = 2;
    const failed = await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/work' });
    expect(failed.body).not.toContain('does not exist');
  });

  it('cuts the archive off inside the computer, and refuses one over the cap before reading it', async () => {
    computer.archiveBytes = 256 * 1024 * 1024 + 1;
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/' });
    expect(res.json().error).toMatchObject({ code: 'E_QUOTA' });
    expect(res.json().error.message).toContain('256 MiB');
    expect(computer.commands.find((c) => c.includes('tar -czf'))).toContain(`head -c ${256 * 1024 * 1024 + 1} >`);
    expect(computer.reads).toEqual([]);
    expect(computer.commands.some((c) => c.startsWith('rm -f'))).toBe(true);
  });

  it('says tar stopped part-way, rather than sending what it wrote', async () => {
    computer.tarStatus = 2;
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/work' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('tar stopped with status 2');
    expect(computer.reads).toEqual([]);
  });

  it('needs a path', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download' });
    expect(res.statusCode).toBe(422);
  });

  it('404s for a computer that is not there', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/computers/nope/fs/download?path=/work' });
    expect(res.statusCode).toBe(404);
  });

  it('unpacks an uploaded archive with the computer own tar', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/computers/c1/fs/upload?path=/work/incoming',
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.from('PRETEND-TARBALL'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ path: '/work/incoming', bytes: 15 });

    const untar = computer.commands.find((c) => c.includes('tar -xzf'))!;
    expect(untar).toContain("mkdir -p '/work/incoming'");
    expect(untar).toContain("-C '/work/incoming'");
  });

  it('refuses an empty body instead of writing an empty file', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/computers/c1/fs/upload?path=/work',
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(422);
  });

  it('never leaves a path unquoted, so a $(...) in one cannot run', async () => {
    // The path comes off the wire and is interpolated into `sh -c`. The path
    // jail rejects an escape from the workspace; it is not a shell quoter.
    // A double-quoted shell string is not enough either -- it still expands
    // `$(...)` and backticks, which is how the "no such path" message leaked.
    const nasty = `/work/it's $(touch /tmp/pwned) \`whoami\``;
    await ctx.app.inject({
      method: 'GET',
      url: `/v1/computers/c1/fs/download?path=${encodeURIComponent(nasty)}`,
    });

    // A literal backslash, spelled so no layer of escaping can eat it.
    const BACKSLASH = String.fromCharCode(92);

    // What the shell would actually interpret, by sh's own rules: a single
    // quote toggles literal mode, and outside it a backslash escapes the next
    // character. A regex over `'...'` gets this wrong on `'''`, which is
    // sequence `quote()` emits, so this walks the string instead.
    const interpreted = (cmd: string): string => {
      let out = '';
      let inQuote = false;
      for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i]!;
        if (inQuote) {
          if (ch === "'") inQuote = false;
          continue;
        }
        if (ch === "'") inQuote = true;
        else if (ch === BACKSLASH) i++;
        else out += ch;
      }
      return out;
    };

    for (const cmd of computer.commands) {
      expect(interpreted(cmd), cmd).not.toContain('touch /tmp/pwned');
      expect(interpreted(cmd), cmd).not.toContain('whoami');
    }
  });
});

/** Whether this machine can run the script for real: a POSIX sh with tar, gzip and head, as Linux and macOS have. */
const realShell = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v tar && command -v gzip && command -v head']).status === 0;

describe.skipIf(!realShell)('the download script, run in a real shell', () => {
  // Made before the tests, not as the file is read: a skipped block is still read.
  let dir = '';
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'husk-archive-')));
    mkdirSync(join(dir, 'work', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'work', 'a.txt'), 'hello');
    // Random bytes do not compress, so the archive is bigger than a small cap.
    writeFileSync(join(dir, 'work', 'sub', 'noise.bin'), randomBytes(200_000));
  });
  const run = (path: string, cap?: number) => {
    const scratch = join(dir, `out-${Math.random().toString(36).slice(2)}.tgz`);
    const r = spawnSync('sh', ['-c', downloadScript(path, scratch, `${scratch}.rc`, cap)], { encoding: 'utf8' });
    return { status: r.status, out: r.stdout.trim().split(/\s+/), scratch };
  };

  it('archives the path under its own name, and prints its size alone', () => {
    const { status, out, scratch } = run(join(dir, 'work'));
    expect(status).toBe(0);
    expect(out).toEqual([String(statSync(scratch).size)]);
    expect(spawnSync('tar', ['-tzf', scratch], { encoding: 'utf8' }).stdout).toContain('work/a.txt');
  });

  it('exits 66 for a path that is not there', () => {
    expect(run(join(dir, 'nope')).status).toBe(66);
  });

  it('stops one byte past the cap, and writes no more than that', () => {
    const { status, out, scratch } = run(join(dir, 'work'), 1000);
    expect(status).toBe(0);
    expect(out[0]).toBe('1001');
    expect(statSync(scratch).size).toBe(1001);
  });

  it('keeps tar’s own status when it could not read a file', () => {
    if (process.getuid?.() === 0) return; // root reads a file whatever its mode
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'secret'), 'x');
    chmodSync(join(locked, 'secret'), 0o000);
    const { status, out } = run(locked);
    expect(status).toBe(0);
    expect(out[1]).toMatch(/^[1-9]/);
  });
});
