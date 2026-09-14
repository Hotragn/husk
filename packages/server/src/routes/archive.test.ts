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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { buildTestApp, FakeComputer } from '../testing.js';
import type { TestApp } from '../testing.js';
import type { ExecRequest, ExecResult } from '@husk-ai/core';

/**
 * A computer whose `tar` does something.
 *
 * `FakeComputer` answers every exec with "ran: <cmd>", which is enough for
 * routes that only care that a command was issued. These routes read back what
 * tar wrote, so the double has to honour the part of the contract they depend
 * on: `tar -czf X` makes a file at X, `wc -c < X` reports its size.
 */
class TarringComputer extends FakeComputer {
  failTarWith: number | null = null;
  readonly commands: string[] = [];

  override async exec(req: ExecRequest): Promise<ExecResult> {
    const cmd = Array.isArray(req.cmd) ? req.cmd.join(' ') : req.cmd;
    this.commands.push(cmd);

    const created = /tar -czf '([^']+)'/.exec(cmd);
    if (created) {
      if (this.failTarWith !== null) {
        return { exitCode: this.failTarWith, stdout: '', stderr: 'tar: no such file', durationMs: 1, truncated: false, timedOut: false };
      }
      await this.writeFile(created[1]!, Buffer.from('PRETEND-TARBALL'));
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, truncated: false, timedOut: false };
    }

    const sized = /wc -c < '([^']+)'/.exec(cmd);
    if (sized) {
      const bytes = (await this.readFile(sized[1]!).catch(() => new Uint8Array())).length;
      return { exitCode: 0, stdout: `${bytes}\n`, stderr: '', durationMs: 1, truncated: false, timedOut: false };
    }

    const removed = /rm -f '([^']+)'/.exec(cmd);
    if (removed) await this.remove(removed[1]!);

    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, truncated: false, timedOut: false };
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
    computer.failTarWith = 1;
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/work' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(computer.commands.some((c) => c.startsWith('rm -f'))).toBe(true);
  });

  it('says the path does not exist rather than reporting a tar failure', async () => {
    // exit 2 is the guard in the script, not tar's own failure, and the hint
    // should send someone to `ls` rather than to their tar installation.
    computer.failTarWith = 2;
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/computers/c1/fs/download?path=/nope' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('does not exist');
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
