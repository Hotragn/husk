#!/usr/bin/env node
/**
 * Everything that can be checked before a publish, without publishing.
 *
 * The release workflow does most of this in CI, but CI is the wrong place to
 * discover that a package name is taken or a version is already on the
 * registry: by then a tag exists and half the packages may already be up.
 * npm has no "undo", only "publish something newer", so the checks that
 * matter run first, locally, and say plainly what would go wrong.
 *
 * Read-only. It creates nothing, tags nothing, and publishes nothing.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const rawRun = promisify(execFile);

/**
 * Run npm.
 *
 * On Windows npm is a `.cmd`, which `execFile` cannot spawn directly -- it
 * fails with EINVAL -- so a shell is required there. Node warns that shell
 * arguments are concatenated rather than escaped; that is acceptable here and
 * only here, because every argument below is a literal or a package name read
 * from our own package.json, never anything a caller supplies.
 */
const run = (cmd, args, opts = {}) =>
  rawRun(cmd, args, { ...opts, ...(process.platform === 'win32' ? { shell: true } : {}) });
// `fileURLToPath`, not `.pathname`: a repo checked out under a path with a
// space comes back percent-encoded otherwise, and every read fails on a
// directory called `Claude%20Code`.
const root = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
let warnings = 0;

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const warn = (m) => {
  warnings++;
  console.log(`  warn  ${m}`);
};

/** The order packages must be published in: a dependency before its dependents. */
const ORDER = ['core', 'runtime', 'models', 'browser', 'sessions', 'agent', 'adapters', 'mcp', 'server', 'sdk', 'cli'];

async function readPkg(dir) {
  return JSON.parse(await readFile(join(root, 'packages', dir, 'package.json'), 'utf8'));
}

/**
 * ORDER is checked below for being dependency-correct. This checks that the
 * release actually uses it.
 *
 * `release.yml` publishes with its own hardcoded `for pkg in ...` loop. Today
 * the two lists agree; nothing makes them. Add a package to one and not the
 * other and the release publishes in the wrong order or skips a package, and
 * because every cross-workspace dependency is pinned to an exact version, a
 * dependent published before its dependency is a hard `notarget` for whoever
 * installs it next. npm has no undo, so the recovery is another release.
 *
 * Of everything in this script, this is the check guarding the only step with
 * no rollback.
 */
async function checkReleaseOrder() {
  let yml;
  try {
    yml = await readFile(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  } catch {
    bad('.github/workflows/release.yml is missing -- nothing publishes');
    return;
  }
  const m = /for pkg in ([a-z0-9 -]+); do/.exec(yml);
  if (!m) {
    bad('release.yml has no `for pkg in ...` publish loop -- has the publish step been rewritten?');
    return;
  }
  const loop = m[1].trim().split(/\s+/);
  if (JSON.stringify(loop) === JSON.stringify(ORDER)) {
    ok(`release.yml publishes in the same order (${ORDER.length} packages)`);
    return;
  }
  const missing = ORDER.filter((p) => !loop.includes(p));
  const extra = loop.filter((p) => !ORDER.includes(p));
  if (missing.length) bad(`release.yml never publishes: ${missing.join(', ')}`);
  if (extra.length) bad(`release.yml publishes packages that are not in ORDER: ${extra.join(', ')}`);
  if (!missing.length && !extra.length) {
    bad(`release.yml publishes in a different order than ORDER\n          ORDER: ${ORDER.join(' ')}\n          yml:   ${loop.join(' ')}`);
  }
}

console.log('\nhusk publish preflight\n');

// ---------------------------------------------------------------- packages
console.log('packages');
const dirs = (await readdir(join(root, 'packages'), { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const missing = dirs.filter((d) => !ORDER.includes(d));
await checkReleaseOrder();

if (missing.length) bad(`not in the publish order, so they would never ship: ${missing.join(', ')}`);
else ok(`${dirs.length} packages, all in the publish order`);

const pkgs = Object.fromEntries(await Promise.all(dirs.map(async (d) => [d, await readPkg(d)])));

// One version across the workspace. Mixed versions make "which release is
// this" unanswerable, and the release workflow checks the tag against core.
const versions = new Set(Object.values(pkgs).map((p) => p.version));
if (versions.size === 1) ok(`all at ${[...versions][0]}`);
else bad(`versions disagree: ${[...versions].join(', ')}`);

// A workspace dependency published as `*` or `workspace:*` installs nothing
// usable for a consumer.
for (const [dir, p] of Object.entries(pkgs)) {
  for (const [dep, range] of Object.entries(p.dependencies ?? {})) {
    if (!dep.startsWith('@husk-ai/')) continue;
    if (/^(workspace:|\*)/.test(range)) bad(`${p.name} depends on ${dep}@${range}, which cannot resolve off the workspace`);
    const target = pkgs[dep.replace('@husk-ai/', '')];
    if (target && range !== target.version) {
      warn(`${p.name} wants ${dep}@${range} but that package is ${target.version}`);
    }
    if (target && ORDER.indexOf(dep.replace('@husk-ai/', '')) > ORDER.indexOf(dir)) {
      bad(`${p.name} depends on ${dep}, which publishes later -- reorder`);
    }
  }
}
if (!failures) ok('workspace dependencies are pinned and correctly ordered');

// ------------------------------------------------------------------ files
console.log('\ncontents');
const failuresBeforePack = failures;
for (const dir of ORDER) {
  const p = pkgs[dir];
  if (!p) continue;
  let packed;
  try {
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json'], {
      cwd: join(root, 'packages', dir),
      maxBuffer: 32 * 1024 * 1024,
    });
    packed = JSON.parse(stdout)[0];
  } catch (e) {
    bad(`${p.name}: npm pack failed -- ${String(e.message).split('\n')[0]}`);
    continue;
  }

  const tests = packed.files.filter((f) => /\.test\./.test(f.path)).length;
  if (tests) warn(`${p.name} ships ${tests} test files`);
  if (packed.unpackedSize < 2000) bad(`${p.name} packs ${packed.unpackedSize} bytes -- did its build run?`);
  else if (!packed.files.some((f) => /^dist\//.test(f.path))) bad(`${p.name} has no dist/ -- did its build run?`);
}
// Only claim this when nothing above objected; an unconditional `ok` after a
// loop that can fail is exactly the kind of reassuring lie this script exists
// to catch in other things.
if (failures === failuresBeforePack) ok('every package packs a built dist');

// --------------------------------------------------------------- registry
console.log('\nregistry');
const failuresBeforeRegistry = failures;
for (const dir of ORDER) {
  const p = pkgs[dir];
  if (!p) continue;
  try {
    const { stdout } = await run('npm', ['view', `${p.name}@${p.version}`, 'version']);
    if (stdout.trim()) bad(`${p.name}@${p.version} is already published -- bump the version`);
  } catch {
    // A 404 is the good case: this version does not exist yet.
  }
}
if (failures === failuresBeforeRegistry) ok('no version collides with what is already on the registry');

try {
  const { stdout } = await run('npm', ['whoami']);
  ok(`authenticated as ${stdout.trim()}`);
  try {
    await run('npm', ['access', 'list', 'packages', '@husk']);
    ok('the @husk scope is reachable with these credentials');
  } catch {
    warn('cannot read the @husk scope -- create the org, or check the token has write access to it');
  }
} catch {
  warn('not logged in (`npm login`), so scope access could not be checked');
}

// ------------------------------------------------------------------ done
console.log('');
if (failures) {
  console.log(`${failures} blocking problem${failures === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}. Do not publish.\n`);
  process.exit(1);
}
console.log(`ready to publish${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}.\n`);
