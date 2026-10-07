#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bundled = process.argv.includes('--bundle');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
let entry = join(root, 'packages/mcp/dist/bin.js');
let args = [entry, '--profile', 'starter'];
let bundleRoot;
let archive;
if (bundled) {
  const next = process.argv[process.argv.indexOf('--bundle') + 1];
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  archive = resolve(next && !next.startsWith('--') ? next : join(root, 'build', `husk-${version}.mcpb`));
  const checksum = await readFile(`${archive}.sha256`, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (checksum) assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), checksum.split(/\s/)[0], 'archive matches its SHA-256 sidecar');
  // Outside the checkout: an omitted dependency must not accidentally resolve
  // from the developer's node_modules or from the build staging directory.
  bundleRoot = await mkdtemp(join(tmpdir(), 'husk-mcpb-unpacked-'));
  const packageRoot = join(root, 'node_modules', '@anthropic-ai', 'mcpb');
  const packager = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const cli = join(packageRoot, typeof packager.bin === 'string' ? packager.bin : packager.bin.mcpb);
  await run(process.execPath, [cli, 'unpack', archive, bundleRoot], { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  await run(process.execPath, [cli, 'validate', join(bundleRoot, 'manifest.json')], { cwd: root });
  const manifest = JSON.parse(await readFile(join(bundleRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.mcp_config.command, 'node');
  entry = resolve(bundleRoot, manifest.server.entry_point);
  const entryRelative = relative(bundleRoot, entry);
  assert.ok(entryRelative && !entryRelative.startsWith('..') && !isAbsolute(entryRelative), 'entry point is inside the extracted archive');
  args = manifest.server.mcp_config.args.map((arg) => arg.replaceAll('${__dirname}', bundleRoot));
  assert.ok(args.every((arg) => !arg.includes('${')), 'manifest command has no unresolved host variables');
  assert.equal(resolve(args[0]), entry, 'manifest launches its declared entry point');
  assert.ok(args.includes('starter'), 'manifest starts with workspace tools only');
  for (const name of await readdir(join(bundleRoot, 'node_modules', '@husk-ai'))) {
    const pkg = JSON.parse(await readFile(join(bundleRoot, 'node_modules', '@husk-ai', name, 'package.json'), 'utf8'));
    assert.equal(pkg.version, manifest.version, `bundled ${pkg.name} version matches manifest`);
  }
  console.log(`Testing extracted archive: ${archive}`);
}
const home = await mkdtemp(join(tmpdir(), 'husk-starter-smoke-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([,v]) => v !== undefined));
delete env.HUSK_SESSION;
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
env.HUSK_HOME = home;
let client;
let passed = false;
async function connect() {
  client = new Client({ name: 'starter-smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args, env, cwd: bundleRoot ?? root, stderr: 'inherit' }));
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content[0].text);
}
try {
  await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes('workspace_create') && !tools.includes('shell'));
  const created = await call('workspace_create', { name: 'My first brief' });
  const sources = [];
  if (process.argv.includes('--online')) {
    for (const url of ['https://example.com', 'https://nodejs.org/en', 'https://modelcontextprotocol.io']) {
      const capture = await call('source_add', { url });
      assert.ok(capture.content.length > 0);
      sources.push(capture.source.id);
    }
  }
  await call('workspace_write', { path: 'brief.md', content: '# Saved brief\n\nThis fixture verifies persistence and downloads, not AI synthesis.\n', sourceIds: sources });
  const blocked = await client.callTool({ name: 'shell', arguments: { command: 'echo forbidden' } });
  assert.equal(blocked.isError, true);
  await client.close();
  await connect();
  const reopened = await call('workspace_open', { name: 'my FIRST brief' });
  assert.equal(reopened.id, created.id);
  assert.match((await call('workspace_read', { path: 'outputs/brief.md' })).content, /Saved brief/);
  const link = new URL((await call('workspace_open_ui')).url);
  const token = new URLSearchParams(link.hash.slice(1)).get('token');
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${link.origin}/v1/workspaces`)).status, 401);
  const listing = await fetch(`${link.origin}/v1/workspaces`, { headers });
  assert.equal(listing.status, 200);
  assert.equal((await listing.json()).workspaces[0].id, created.id);
  const page = await fetch(link.origin);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(!html.includes('bundle has not been built'));
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset, 'built JavaScript asset is present');
  assert.equal((await fetch(new URL(asset, link.origin))).status, 200);
  const download = await fetch(`${link.origin}/v1/workspaces/${created.id}/download?path=outputs%2Fbrief.md`, { headers });
  assert.match(await download.text(), /Saved brief/);
  const zip = await fetch(`${link.origin}/v1/workspaces/${created.id}/export`, { headers });
  assert.equal(zip.status, 200);
  assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  const missing = await fetch(`${link.origin}/v1/workspaces/not-real`, { headers });
  assert.ok(missing.status >= 400 && missing.status < 500);
  passed = true;
  console.log(`PASS: ${bundled ? 'extracted .mcpb archive' : 'built packages'} starter tools, restart persistence, source IDs, viewer auth, packaged assets, file download and ZIP export.`);
} finally {
  await client?.close();
  if (passed && !process.argv.includes('--keep')) {
    // Both are exact mkdtemp results; never remove a path supplied by a caller.
    for (const path of [home, bundleRoot].filter(Boolean)) {
      const rel = relative(resolve(tmpdir()), resolve(path));
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/') && !rel.includes('\\'), 'cleanup stays inside the temporary directory');
      await rm(path, { recursive: true, force: true });
    }
  } else {
    console.log(`Kept smoke-test state: ${home}${bundleRoot ? `\nExtracted bundle: ${bundleRoot}` : ''}`);
  }
}
