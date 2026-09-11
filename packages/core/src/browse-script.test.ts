import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FETCH_SCRIPT } from './browse.js';

/**
 * The fetch script, executed for real.
 *
 * `browse.test.ts` mocks the script's stdout, which is right for testing the
 * policy gate and the parsing -- but it cannot see the bug this file exists for.
 * `maxBytes` used to cap the HTML *download*, so a small budget cut the document
 * mid-`<script>`, the non-greedy `</script>` match found nothing to close
 * against, and the whole script body survived stripping. The only way to catch a
 * regression in that ordering is to run the script.
 *
 * Skipped, visibly, when no python interpreter is on PATH.
 */
function findPython(): string | undefined {
  for (const bin of ['python3', 'python']) {
    const r = spawnSync(bin, ['-c', 'print(1)'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return undefined;
}

const PYTHON = findPython();

/** Prose the model is meant to read, and a script body it must never see. */
const PROSE_MARKER = 'ARTICLE_BODY_THE_MODEL_SHOULD_READ';
const SCRIPT_MARKER = 'var gform;gform||(document.addEventListener(';

/**
 * A page shaped like the one in the bug report: a large inline script early in
 * the document, prose after it. Any raw cap below the script's closing tag used
 * to leak `SCRIPT_MARKER`.
 */
function pageHtml(): string {
  const filler = 'x'.repeat(40_000);
  return [
    '<!doctype html><html><head><title>A Real Article</title>',
    `<script>${SCRIPT_MARKER}"DOMContentLoaded",function(){/* ${filler} */});</script>`,
    '<style>body{color:red}</style>',
    '</head><body>',
    '<nav><a href="/home">Home</a><a href="/about">About</a></nav>',
    `<p>${PROSE_MARKER}</p>`,
    `<p>${'and more prose. '.repeat(200)}</p>`,
    '</body></html>',
  ].join('');
}

let baseUrl = '';
let scriptPath = '';
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(pageHtml());
});

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  scriptPath = join(await mkdtemp(join(tmpdir(), 'husk-browse-script-')), 'fetch.py');
  await writeFile(scriptPath, FETCH_SCRIPT, 'utf8');
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

interface ScriptOut {
  text: string;
  title: string;
  links: Array<{ text: string; href: string }>;
  bytes: number;
  truncated: boolean;
  textTruncated: boolean;
  rawTruncated: boolean;
}

async function runScript(maxBytes: number, rawBytes: number): Promise<ScriptOut> {
  const proc = spawn(PYTHON as string, [scriptPath, baseUrl, '1', '30', String(maxBytes), String(rawBytes)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c: string) => (stdout += c));
  proc.stderr.on('data', (c: string) => (stderr += c));
  const code = await new Promise<number>((done) => proc.on('close', (c) => done(c ?? 1)));
  if (code !== 0) throw new Error(`fetch script exited ${code}: ${stderr}`);
  return JSON.parse(stdout.trim()) as ScriptOut;
}

describe.skipIf(!PYTHON)('the fetch script, run for real', () => {
  it('strips scripts before capping, so a tiny text budget still returns prose', async () => {
    // 1200 was the reproduction in the bug report. The raw budget is the floor
    // `rawBudgetFor` would hand it, not the text budget -- that is the fix.
    const out = await runScript(1200, 1024 * 1024);

    expect(out.text).not.toContain(SCRIPT_MARKER);
    expect(out.text).not.toContain('document.addEventListener');
    expect(out.text).toContain(PROSE_MARKER);
    expect(out.textTruncated).toBe(true);
    expect(out.rawTruncated).toBe(false);
  });

  it('returns the same clean prose at a large text budget', async () => {
    const out = await runScript(200 * 1024, 1024 * 1024);
    expect(out.text).not.toContain(SCRIPT_MARKER);
    expect(out.text).toContain(PROSE_MARKER);
    expect(out.title).toBe('A Real Article');
    expect(out.textTruncated).toBe(false);
  });

  it('keeps the text budget as a byte ceiling on the prose', async () => {
    const out = await runScript(1200, 1024 * 1024);
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(1200);
  });

  it('still finds links, which a cap on the download would have eaten', async () => {
    const out = await runScript(1200, 1024 * 1024);
    expect(out.links.map((l) => l.href)).toEqual([`${baseUrl}home`, `${baseUrl}about`]);
  });

  it('reports a cut download separately from a cut text', async () => {
    // A raw budget small enough to land inside the script: the document really
    // is incomplete, and the caller is told so rather than being told the text
    // was merely capped.
    const out = await runScript(200 * 1024, 2048);
    expect(out.rawTruncated).toBe(true);
    expect(out.truncated).toBe(true);
  });
});
