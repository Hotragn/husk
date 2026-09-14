import { Buffer } from 'node:buffer';
import type { Computer } from '@husk/core';
import { HuskError } from '@husk/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ctxOf } from '../context.js';
import { notFound } from '../errors.js';

/**
 * Getting a directory in and out of a computer.
 *
 * These two routes were documented for months as "not implemented", with the
 * reason given as the build contract: every usable tar on npm is either a
 * native module or a large dependency, and husk ships neither. That reasoning
 * was sound and the conclusion was wrong. The tar we need is not on npm -- it
 * is already inside the machine, along with gzip, on every image husk supports
 * and on a stock WSL. The archive is made and unmade *there*, and only bytes
 * cross the boundary, over the same `readFile`/`writeFile` path `fs/read` and
 * `fs/write` already use.
 *
 * That also happens to be the more correct design. Tarring on the host would
 * mean reading a directory the host may not be able to see at all -- on docker,
 * podman, fly and ssh it cannot -- so the work belongs where the files are.
 *
 * Upload needs no multipart parser for the same reason: the body is the
 * archive, not a form containing one. A multipart parser would exist purely to
 * unwrap a single part.
 */

/** Room for a source tree, not for a dataset. Both directions. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** Where the archive is staged inside the machine, never in the jailed workspace. */
function scratchPath(): string {
  return `/tmp/.husk-archive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tgz`;
}

function requirePath(query: unknown): string {
  const p = (query as { path?: unknown })?.path;
  if (typeof p !== 'string' || p.length === 0) {
    throw new HuskError('E_SPEC_INVALID', 'missing required query parameter `path`', {
      hint: 'e.g. /v1/computers/:id/fs/download?path=/work',
    });
  }
  return p;
}

async function mustGet(app: FastifyInstance, id: string): Promise<Computer> {
  const computer = await ctxOf(app).deps.manager.get(id);
  if (!computer) throw notFound('computer', id);
  return computer;
}

/**
 * Quote a path for the shell that runs inside the computer.
 *
 * The path is attacker-influenced in the sense that matters here -- it comes off
 * the wire -- and it is about to be interpolated into a `sh -c`. The provider's
 * path jail rejects an escape from the workspace, but it is not a shell quoter
 * and nothing else between here and `sh` is either.
 */
function quote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Fail with the machine's own words rather than a bare exit code. */
function execFailed(what: string, stderr: string, hint: string): HuskError {
  return new HuskError('E_EXEC_FAILED', what, { hint, details: { stderr: stderr.slice(0, 500) } });
}

export async function archiveRoutes(app: FastifyInstance): Promise<void> {
  /**
   * `GET /v1/computers/:id/fs/download?path=/work` -> a gzipped tar.
   *
   * Paths inside the archive are relative to the directory asked for, so
   * unpacking it somewhere else does not scatter files across that tree.
   */
  app.get('/v1/computers/:id/fs/download', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const path = requirePath(req.query);
    const computer = await mustGet(app, id);
    const scratch = scratchPath();

    // `-C parent base` rather than tarring an absolute path: GNU tar strips the
    // leading slash with a warning, and the resulting archive's shape then
    // depends on which tar unpacked it.
    const made = await computer.exec({
      cmd:
        // The path is single-quoted everywhere it appears, including inside
        // the message: a double-quoted shell string still expands `$(...)`
        // and backticks, so `path=/work/$(id)` would have run `id`.
        `set -e; test -e ${quote(path)} || { echo no such path: ${quote(path)} >&2; exit 2; }; ` +
        `tar -czf ${quote(scratch)} -C "$(dirname ${quote(path)})" "$(basename ${quote(path)})"`,
      timeoutSec: 600,
    });

    if (made.exitCode !== 0) {
      await computer.exec({ cmd: `rm -f ${quote(scratch)}`, timeoutSec: 30 }).catch(() => undefined);
      throw execFailed(
        `could not archive ${path}`,
        made.stderr,
        made.exitCode === 2
          ? 'the path does not exist in the computer; check with `husk exec <name> -- ls -la <path>`'
          : 'the computer needs tar and gzip for this; every husk image has both',
      );
    }

    try {
      const size = await computer.exec({ cmd: `wc -c < ${quote(scratch)}`, timeoutSec: 30 });
      const bytes = Number(size.stdout.trim());
      if (Number.isFinite(bytes) && bytes > MAX_ARCHIVE_BYTES) {
        // Refused before it is read, so an accidental `path=/` does not pull a
        // whole root filesystem into this process's memory to be rejected after.
        throw new HuskError('E_QUOTA', `${path} compresses to ${bytes} bytes, over the ${MAX_ARCHIVE_BYTES} limit`, {
          hint: 'archive a subdirectory, or make the tarball yourself with `exec` and read it with fs/read',
          details: { bytes, limit: MAX_ARCHIVE_BYTES },
        });
      }

      const data = await computer.readFile(scratch);
      return reply
        .type('application/gzip')
        .header('content-disposition', `attachment; filename="${id}.tgz"`)
        .send(Buffer.from(data));
    } finally {
      await computer.exec({ cmd: `rm -f ${quote(scratch)}`, timeoutSec: 30 }).catch(() => undefined);
    }
  });

  /**
   * `POST /v1/computers/:id/fs/upload?path=/work` -- body is a gzipped tar.
   *
   * The destination directory is created if it is missing, which is what makes
   * this usable as "put this project into a fresh machine".
   */
  app.post('/v1/computers/:id/fs/upload', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const path = requirePath(req.query);
    const computer = await mustGet(app, id);

    const body = req.body;
    const archive = body instanceof Buffer ? body : Buffer.from(String(body ?? ''), 'binary');
    if (archive.length === 0) {
      throw new HuskError('E_SPEC_INVALID', 'the request body is empty', {
        hint: 'send the .tar.gz bytes as the body, e.g. `curl --data-binary @src.tgz`',
      });
    }

    const scratch = scratchPath();
    await computer.writeFile(scratch, new Uint8Array(archive));

    try {
      const out = await computer.exec({
        cmd: `set -e; mkdir -p ${quote(path)}; tar -xzf ${quote(scratch)} -C ${quote(path)}`,
        timeoutSec: 600,
      });
      if (out.exitCode !== 0) {
        throw execFailed(`could not unpack the archive into ${path}`, out.stderr, 'the body must be a gzipped tar');
      }

      const listed = await computer.listDir(path).catch(() => []);
      ctxOf(app).bus.emit('computers', 'uploaded', { id, path, bytes: archive.length });
      return reply.code(200).send({ path, bytes: archive.length, entries: listed.length });
    } finally {
      await computer.exec({ cmd: `rm -f ${quote(scratch)}`, timeoutSec: 30 }).catch(() => undefined);
    }
  });
}
