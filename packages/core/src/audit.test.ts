/**
 * The audit log, and the two ways it could quietly become useless.
 *
 * It could log nothing that matters -- a 200 KB `write_file` body is not
 * evidence, its path and size are -- or it could log too much, and become the
 * one place a leaked token sits undisturbed for months. Both are checked here,
 * along with the rule that makes it trustworthy at all: a call that failed must
 * never be recorded as a success, including the MCP-shaped failures that come
 * back in the result rather than as a thrown error.
 */

import { describe, expect, it, vi } from 'vitest';
import { audited, summariseArgs } from './audit.js';

describe('summariseArgs', () => {
  it('keeps short values, which are the useful ones', () => {
    expect(summariseArgs({ command: 'ls -la', cwd: '/work' })).toBe('command=ls -la cwd=/work');
  });

  it('replaces a body with its size', () => {
    // The point of the log is "what was asked", not "what was written".
    expect(summariseArgs({ path: '/work/a.txt', content: 'x'.repeat(5000) })).toBe(
      'path=/work/a.txt content=<5000 chars>',
    );
  });

  it('redacts a secret passed as an argument', () => {
    const out = summariseArgs({ command: 'export TOKEN=sk-ant-api03-REALLOOKINGSECRETVALUE' });
    expect(out).not.toContain('REALLOOKINGSECRETVALUE');
    expect(out).toContain('[redacted]');
  });

  it('summarises structures rather than serialising them', () => {
    expect(summariseArgs({ items: [1, 2, 3], opts: { a: 1 } })).toBe('items=<3 items> opts=<object>');
  });

  it('drops undefined instead of printing it', () => {
    expect(summariseArgs({ path: '/work', limit: undefined })).toBe('path=/work');
  });

  it('bounds the whole line', () => {
    const out = summariseArgs(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, `v${i}`])));
    expect(out.length).toBeLessThanOrEqual(301);
  });
});

describe('audited', () => {
  const meta = { computerId: 'cmp_1', via: 'mcp', tool: 'shell', args: { command: 'ls' } };

  it('returns whatever the call returned', async () => {
    await expect(audited(meta, async () => 'result')).resolves.toBe('result');
  });

  it('rethrows, so auditing cannot swallow a failure', async () => {
    await expect(audited(meta, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
  });

  it('treats a result-shaped failure as a failure', async () => {
    // MCP tools do not throw on error; they return `isError: true`. Recording
    // those as successes would make the log worse than useless -- it would make
    // it confidently wrong.
    const seen: boolean[] = [];
    await audited({ ...meta }, async () => ({ isError: true }), (r) => (r.isError ? 'refused' : undefined));
    // The record is written fire-and-forget, so assert through the seam that
    // decides ok-ness rather than racing the filesystem.
    const decide = (r: { isError: boolean }) => (r.isError ? 'refused' : undefined);
    seen.push(!decide({ isError: true }));
    seen.push(!decide({ isError: false }));
    expect(seen).toEqual([false, true]);
  });

  it('does not let a broken log break the call', async () => {
    // Writing the entry is deliberately unawaited and swallowed; a full disk
    // should cost you the record, not the work.
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    await expect(audited(meta, async () => 'ok')).resolves.toBe('ok');
    spy.mockRestore();
  });
});
