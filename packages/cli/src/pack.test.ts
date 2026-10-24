import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * What `npm i -g @husk-ai/cli` actually gives someone.
 *
 * Everything else in this suite runs the source, or `node dist/bin.js`. Neither
 * goes through `package.json#bin`, and that is precisely the path that broke:
 * 0.1.1 shipped a `bin` pointing at a wrapper, the wrapper imported a module
 * guarded on `process.argv[1] === import.meta.url`, and through the wrapper
 * those never match -- so every published `husk` command exited 0 having
 * printed nothing, on every platform. A test that skips the shim cannot see it.
 *
 * So this packs the tarball npm would publish, installs it somewhere else
 * entirely, and runs the `husk` that lands in `node_modules/.bin`.
 *
 * Opt in with HUSK_INTEGRATION=1: it runs `npm pack` and `npm install`, which
 * the suite's no-network contract does not allow by default.
 *
 *     HUSK_INTEGRATION=1 npx vitest run packages/cli
 *
 * This is the half `scripts/drift-check.mjs` cannot reach. That pins the version
 * literals to each other in the source; this asserts the built, packed,
 * installed artifact actually says the number out loud.
 */
const integration = process.env.HUSK_INTEGRATION === '1';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let scratch: string | undefined;

/**
 * The CLI and every @husk-ai package it pulls in, optional ones too. Packed
 * together, so the install resolves them from these tarballs: before a
 * release none of this version is on npm, and after one this tests the code
 * here rather than what was published.
 */
function packages(): string[] {
  const byName = new Map<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>();
  for (const dir of readdirSync(join(repoRoot, 'packages'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages', dir, 'package.json'), 'utf8')) as { name: string };
      byName.set(pkg.name, pkg);
    } catch {
      // not a package
    }
  }
  const found = new Set<string>();
  const visit = (name: string): void => {
    const pkg = byName.get(name);
    if (!pkg || found.has(name)) return;
    found.add(name);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep);
  };
  visit('@husk-ai/cli');
  return [...found];
}

afterAll(() => {
  // `maxRetries` for the same reason as smoke.test.ts (#80): this directory has
  // just had `npm pack` and `npm install` running inside it, and Windows keeps a
  // handle on a reaped process's working directory long enough for an unretried
  // rmdir to lose with EBUSY. Gated on HUSK_INTEGRATION, so it has had far fewer
  // chances to flake -- not fewer reasons to.
  if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe.skipIf(!integration)('the published tarball', () => {
  it('runs, and says the version its own manifest claims', () => {
    scratch = mkdtempSync(join(tmpdir(), 'husk-pack-'));

    execFileSync('npm', ['pack', ...packages().flatMap((name) => ['-w', name]), '--pack-destination', scratch], {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: true,
    });
    const tarballs = readdirSync(scratch).filter((f) => f.endsWith('.tgz'));
    expect(tarballs.some((f) => f.startsWith('husk-ai-cli-')), 'npm pack produced no CLI tarball').toBe(true);

    execFileSync('npm', ['init', '-y'], { cwd: scratch, stdio: 'pipe', shell: true });
    execFileSync('npm', ['install', ...tarballs.map((f) => join(scratch as string, f))], {
      cwd: scratch,
      stdio: 'pipe',
      shell: true,
    });

    const manifest = join(scratch, 'node_modules', '@husk-ai', 'cli', 'package.json');
    const installed = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };

    // Through node_modules/.bin, not through dist/bin.js. The shim is the part
    // that was broken, so the shim is the part that has to be exercised.
    //
    // `shell: true` is not laziness: npm writes a .cmd shim on Windows, and
    // since the CVE-2024-27980 mitigation Node refuses to execFile a .cmd
    // without one -- it fails EINVAL. The arguments here are literals.
    const out = execFileSync(join(scratch, 'node_modules', '.bin', 'husk'), ['--version'], {
      cwd: scratch,
      encoding: 'utf8',
      shell: true,
    });

    expect(out.trim(), '`husk --version` printed nothing: bin wiring is broken').not.toBe('');

    const printed = /\d+\.\d+\.\d+/.exec(out)?.[0];
    expect(printed).toBe(installed.version);
  }, 600_000);
});
