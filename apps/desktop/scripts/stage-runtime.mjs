#!/usr/bin/env node
// Stage the Husk the desktop app carries: the same tarballs a user installs
// from npm, installed with production dependencies only, into build/runtime.
// electron-builder copies that folder into the app's resources.
//
// Run `npm run build` at the repo root first, so every package's dist/ exists.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const out = resolve(here, '..', 'build', 'runtime');
const run = promisify(execFile);
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this with `npm run stage`.');

const { version, overrides } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
await mkdir(join(repo, 'build'), { recursive: true });
const packed = await mkdtemp(join(repo, 'build', 'desktop-tarballs-'));

const tarballs = {};
for (const dir of await readdir(join(repo, 'packages'))) {
  const pkg = JSON.parse(await readFile(join(repo, 'packages', dir, 'package.json'), 'utf8'));
  if (pkg.private) continue;
  const { stdout } = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', packed], {
    cwd: join(repo, 'packages', dir),
    maxBuffer: 8 * 1024 * 1024,
  });
  tarballs[pkg.name] = `file:${join(packed, JSON.parse(stdout)[0].filename).replaceAll('\\', '/')}`;
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const manifest = (deps) => JSON.stringify({ name: 'husk-desktop-runtime', private: true, version, type: 'module', dependencies: deps }, null, 2);
// The repo's own overrides come too, so the app ships the dependency fixes the repo is tested with.
await writeFile(join(out, 'package.json'), manifest({ '@husk-ai/mcp': tarballs['@husk-ai/mcp'] }).replace(/}\s*$/, `,\n  "overrides": ${JSON.stringify({ ...overrides, ...tarballs })}\n}`));
console.log('Installing the production dependency graph…');
await run(process.execPath, [npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: out,
  timeout: 600_000,
  maxBuffer: 8 * 1024 * 1024,
});
// Ship no local tarball paths or usernames.
await writeFile(join(out, 'package.json'), manifest({ '@husk-ai/mcp': version }));
await rm(join(out, 'package-lock.json'), { force: true });
await rm(join(out, 'node_modules', '.package-lock.json'), { force: true });
await rm(packed, { recursive: true, force: true });
console.log(`Staged Husk ${version} at ${out}`);
