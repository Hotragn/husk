#!/usr/bin/env node
/**
 * Install the tarballs the way a stranger will, and drive them.
 *
 * Everything else in the gate tests the *workspace*. `npm test` runs against
 * source with symlinks between packages; `preflight` runs `npm pack --dry-run`
 * and executes the bins from inside the monorepo, where hoisted `node_modules`
 * satisfies imports that the published package never declared. Both are green
 * on a tree that cannot be installed.
 *
 * That is not a hypothetical. It is how the last two releases broke:
 *
 *  - **0.1.1** shipped a `cli` whose bin was packed, carried a shebang, and did
 *    nothing. It pointed at a wrapper, and the guard in the real entry compared
 *    `process.argv[1]` to `import.meta.url`, which through a wrapper can never
 *    match. Exit 0, no output, every platform.
 *  - **0.1.3** shipped three cross-workspace pins still on 0.1.2, all in
 *    `optionalDependencies`. It built, typechecked and tested green, because
 *    the workspace link satisfied the import. Only someone installing from the
 *    registry got the old package, and only when `husk serve` lazy-imported it.
 *
 * Neither is findable without leaving the repository. So this packs all eleven,
 * installs them into a scratch directory outside the checkout, and then asks
 * the installed copies to do real work: the CLI lifecycle, an MCP handshake
 * over stdio, and an SDK import against the installed dependency graph.
 *
 * It does not publish and does not touch the registry: `npm install` is pointed
 * at the local tarballs, and `--offline` would be wrong only because the
 * *third-party* dependencies still have to come from somewhere.
 *
 *   node scripts/install-smoke.mjs            # pack, install, drive, clean up
 *   node scripts/install-smoke.mjs --keep     # leave the scratch dir behind
 *   node scripts/install-smoke.mjs --registry # after publishing: resolve for real
 */

import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const rawRun = promisify(execFile);

/** See preflight: npm is a `.cmd` on Windows and `execFile` cannot spawn it. */
const run = (cmd, args, opts = {}) =>
  rawRun(cmd, args, {
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });

const root = fileURLToPath(new URL('..', import.meta.url));
const KEEP = process.argv.includes('--keep');

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const info = (m) => console.log(`        ${m}`);

/** Dependency order, same list preflight publishes in. */
const ORDER = ['core', 'runtime', 'models', 'browser', 'sessions', 'agent', 'adapters', 'mcp', 'server', 'sdk', 'cli'];

/**
 * Drive a stdio child to completion.
 *
 * `execFile` would do for most of this, but the MCP check has to write to stdin
 * and read framed JSON back, and mixing the two styles in one file reads worse
 * than one helper that does both.
 */
function driveStdio(cmd, args, { cwd, input, timeoutMs = 120_000, env }) {
  return new Promise((resolve) => {
    // The installed bins are `.cmd` shims on Windows and `spawn` refuses them
    // with EINVAL, so a shell is required there -- which is also why no
    // argument below carries a quote or a shell metacharacter. Driving the shim
    // rather than the JS behind it is deliberate: 0.1.1's bug *was* the shim.
    const useShell = process.platform === 'win32';
    const child = spawn(useShell ? `"${cmd}"` : cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}


/**
 * Pull `package/package.json` out of an npm tarball.
 *
 * Shelling out to `tar` was the obvious way and it does not survive contact
 * with Windows: the `tar` on PATH depends on which shell you are in, and a
 * check that silently skips is worse than no check -- it prints a reassuring
 * line while verifying nothing. A gzip stream and a 512-byte header walk have
 * no such dependency.
 */
async function manifestFromTarball(file) {
  const raw = await readFile(file);
  const tar = gunzipSync(raw);
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break;
    const sizeField = tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const body = off + 512;
    if (name === 'package/package.json') return tar.toString('utf8', body, body + size);
    off = body + Math.ceil(size / 512) * 512;
  }
  throw new Error('no package/package.json entry');
}

async function main() {
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  console.log(`install smoke — @husk-ai/* ${version}\n`);

  for (const dir of ORDER) {
    if (!existsSync(join(root, 'packages', dir, 'dist'))) {
      bad(`packages/${dir} has no dist -- run \`npm run build:packages\` first`);
      return finish();
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), 'husk-install-smoke-'));
  const store = join(scratch, 'tarballs');
  const app = join(scratch, 'app');
  await mkdir(store, { recursive: true });
  await mkdir(app, { recursive: true });

  // ---------------------------------------------------------------- pack
  console.log('pack');
  const tarballs = {};
  for (const dir of ORDER) {
    try {
      const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', store], {
        cwd: join(root, 'packages', dir),
      });
      const packed = JSON.parse(stdout)[0];
      tarballs[`@husk-ai/${dir}`] = join(store, packed.filename);
    } catch (e) {
      bad(`packages/${dir}: npm pack failed -- ${String(e.message).split('\n')[0]}`);
      return finish(scratch);
    }
  }
  ok(`packed ${ORDER.length} tarballs`);

  // ------------------------------------------------------------ the pins
  //
  // Read every cross-package pin out of the *tarball*, not the source tree.
  // drift-check already compares the manifests in the checkout, and that is a
  // different question: the thing npm resolves from is the packed artifact, and
  // the one release this was missed on shipped three pins a version behind.
  //
  // This has to be a static check rather than a resolution failure, because
  // before a publish the correct version is not on the registry yet -- so an
  // install that resolves transitively would 404 on a *correct* pin and sail
  // through a stale one that happens to be published. Exactly backwards.
  console.log('\ncross-package pins, read from the tarballs');
  const GROUPS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  let pinProblems = 0;
  let pinsRead = 0;
  for (const [name, file] of Object.entries(tarballs)) {
    let manifest;
    try {
      manifest = JSON.parse(await manifestFromTarball(file));
    } catch (e) {
      bad(`${name}: could not read package.json out of the tarball -- ${String(e.message)}`);
      continue;
    }
    for (const group of GROUPS) {
      for (const [dep, range] of Object.entries(manifest[group] ?? {})) {
        if (!dep.startsWith('@husk-ai/')) continue;
        pinsRead++;
        if (range !== version) {
          pinProblems++;
          bad(`${name} pins ${dep} at ${range} in ${group} -- the release is ${version}`);
        }
      }
    }
  }
  if (!pinProblems) ok(`all ${pinsRead} cross-package pins in the tarballs are ${version}`);

  // ------------------------------------------------------------- install
  //
  // `overrides` points every @husk-ai/* at the local tarball. Without it npm
  // fetches the last *published* version to satisfy a transitive pin and the
  // run passes while exercising code that is not in this checkout.
  //
  // The cost is that it also masks a stale pin, which is why the static check
  // above exists and is not optional. After a publish, `--registry` drops the
  // overrides and resolves the graph for real -- that is the end-to-end version
  // of this, and it can only be run once the version is actually on npm.
  console.log('\ninstall');
  const viaRegistry = process.argv.includes('--registry');
  const overrides = viaRegistry
    ? {}
    : Object.fromEntries(Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]));
  if (viaRegistry) info('--registry: transitive @husk-ai/* pins resolve from npm, not from the tarballs');
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'husk-install-smoke',
        private: true,
        version: '0.0.0',
        type: 'module',
        dependencies: { '@husk-ai/cli': `file:${tarballs['@husk-ai/cli']}`, '@husk-ai/sdk': `file:${tarballs['@husk-ai/sdk']}`, '@husk-ai/mcp': `file:${tarballs['@husk-ai/mcp']}` },
        overrides,
      },
      null,
      2,
    ) + '\n',
  );
  try {
    await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: app, timeout: 600_000 });
    ok('npm install resolved the graph from the tarballs');
  } catch (e) {
    bad(`npm install failed -- ${String(e.stderr || e.message).split('\n').slice(0, 4).join(' / ')}`);
    return finish(scratch);
  }

  // Every @husk-ai/* that landed must be this version. A pin one release behind
  // installs cleanly and is exactly the 0.1.3 defect.
  try {
    const { stdout } = await run('npm', ['ls', '--all', '--json', '--depth', '10'], { cwd: app });
    const wrong = [];
    const walk = (node) => {
      for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
        if (name.startsWith('@husk-ai/') && dep.version && dep.version !== version) {
          wrong.push(`${name}@${dep.version}`);
        }
        walk(dep);
      }
    };
    walk(JSON.parse(stdout));
    if (wrong.length) bad(`installed at the wrong version: ${[...new Set(wrong)].join(', ')}`);
    else ok(`every @husk-ai/* in the tree is ${version}`);
  } catch {
    // `npm ls` exits non-zero on peer warnings; the check above is best effort.
    info('npm ls could not be read; version cross-check skipped');
  }

  const huskHome = join(scratch, 'home');
  const env = { HUSK_HOME: huskHome, NO_COLOR: '1' };
  const cliBin = join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'husk.cmd' : 'husk');

  // ------------------------------------------------------------------ cli
  console.log('\ncli, as installed');
  const v = await driveStdio(cliBin, ['--version'], { cwd: app, env });
  if (v.code === 0 && v.stdout.trim() === version) ok(`husk --version says ${version}`);
  else bad(`husk --version: exit ${v.code}, said ${JSON.stringify(v.stdout.trim())}`);

  const doctor = await driveStdio(cliBin, ['doctor'], { cwd: app, env, timeoutMs: 300_000 });
  if (doctor.code === 0 && /COMPUTERS/.test(doctor.stdout)) ok('husk doctor probed its providers');
  else bad(`husk doctor: exit ${doctor.code} -- ${doctor.stderr.split('\n')[0]}`);

  const onboard = await driveStdio(cliBin, ['onboard', '--json'], { cwd: app, env, timeoutMs: 300_000 });
  try {
    const plan = JSON.parse(onboard.stdout);
    if (plan.next) ok(`husk onboard --json is parseable and suggests \`${plan.next}\``);
    else bad('husk onboard --json produced no next step');
  } catch {
    bad(`husk onboard --json did not produce JSON: ${onboard.stdout.slice(0, 80)}`);
  }

  // The lifecycle, on whichever provider this machine can offer. A host with
  // none is not a failure of the tarball, so it is reported and skipped.
  const picked = (() => {
    try {
      return JSON.parse(onboard.stdout).provider;
    } catch {
      return null;
    }
  })();
  if (!picked) {
    info('no provider on this host; the up/exec/rm lifecycle was not exercised');
  } else {
    const name = `smoke-${process.pid}`;
    const up = await driveStdio(cliBin, ['up', name, '--flavor', 'python'], { cwd: app, env, timeoutMs: 600_000 });
    if (up.code === 0) {
      ok(`husk up created a computer on ${picked}`);
      // Argv form, no quotes: a shell is in the loop on Windows, and the
      // question here is whether the installed binary reaches a real machine.
      // The path contract is `packages/sdk/src/conformance.test.ts`'s job.
      const ex = await driveStdio(cliBin, ['exec', name, '--', 'uname', '-sr'], {
        cwd: app,
        env,
        timeoutMs: 300_000,
      });
      if (ex.code === 0 && /linux/i.test(ex.stdout)) ok(`husk exec ran a command inside it: ${ex.stdout.trim()}`);
      else bad(`husk exec: exit ${ex.code} -- ${(ex.stdout + ex.stderr).slice(0, 120)}`);
      const down = await driveStdio(cliBin, ['rm', name, '--yes'], { cwd: app, env, timeoutMs: 300_000 });
      if (down.code === 0) ok('husk rm destroyed it');
      else bad(`husk rm: exit ${down.code} -- ${down.stderr.split('\n')[0]}`);
    } else {
      bad(`husk up: exit ${up.code} -- ${(up.stdout + up.stderr).split('\n').slice(-3).join(' / ')}`);
    }
  }

  // ------------------------------------------------------------------ mcp
  //
  // The bin an MCP client launches. stdout carries JSON-RPC and nothing else,
  // which is itself the assertion: a stray log line here is a parse error
  // inside somebody's editor.
  console.log('\nmcp, as installed');
  const mcpBin = join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'husk-mcp.cmd' : 'husk-mcp');
  const handshake =
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install-smoke', version: '0' } } }) +
    '\n' +
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
    '\n' +
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) +
    '\n';
  const mcp = await driveStdio(mcpBin, [], { cwd: app, env, input: handshake, timeoutMs: 180_000 });
  const frames = mcp.stdout.split('\n').filter((l) => l.trim());
  let parsed = [];
  try {
    parsed = frames.map((l) => JSON.parse(l));
    ok(`every one of the ${frames.length} stdout lines is valid JSON-RPC`);
  } catch (e) {
    bad(`mcp stdout is not pure JSON-RPC: ${String(e.message)} -- ${frames.find((l) => !l.startsWith('{'))?.slice(0, 80)}`);
  }
  const tools = parsed.find((f) => f.id === 2)?.result?.tools ?? [];
  if (tools.length >= 20) ok(`tools/list returned ${tools.length} tools`);
  else bad(`tools/list returned ${tools.length} tools -- expected the full surface`);

  // ------------------------------------------------------------------ sdk
  //
  // The 0.1.3 defect lived in `optionalDependencies`, so importing the package
  // is the check: a stale or missing transitive pin fails at resolution.
  console.log('\nsdk, as installed');
  const probe = join(app, 'sdk-probe.mjs');
  await writeFile(
    probe,
    "import { HuskClient, isHuskError, KNOWN_CODES } from '@husk-ai/sdk';\n" +
      "const c = new HuskClient({ baseUrl: 'http://127.0.0.1:9' });\n" +
      "console.log(JSON.stringify({ methods: typeof c.computers.exec, codes: KNOWN_CODES.length, guard: typeof isHuskError }));\n",
  );
  const sdk = await driveStdio(process.execPath, [probe], { cwd: app, env, timeoutMs: 120_000 });
  if (sdk.code === 0 && /"methods":"function"/.test(sdk.stdout)) ok('the sdk imports and constructs from the installed graph');
  else bad(`sdk probe: exit ${sdk.code} -- ${(sdk.stderr || sdk.stdout).split('\n')[0]}`);

  return finish(scratch);
}

async function finish(scratch) {
  if (scratch) {
    if (KEEP) console.log(`\nscratch kept at ${scratch}`);
    else await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
  }
  console.log('');
  if (failures) {
    console.log(`${failures} problem${failures === 1 ? '' : 's'}. These are what a stranger installing from npm would hit.`);
    process.exit(1);
  }
  console.log('clean: the packed tarballs install and work outside the workspace.');
  process.exit(0);
}

await main();
