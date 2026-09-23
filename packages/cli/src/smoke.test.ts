import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The CLI as a user meets it: a real subprocess, real argv, real exit codes.
 *
 * Unit tests can prove a function returns 2; only a subprocess can prove the
 * process exits 2, that stdout stayed parseable, and that the shebang works.
 *
 * Every test runs against a throwaway HUSK_HOME so a developer's own computers
 * are never listed, never destroyed, and never counted against a quota.
 */
/**
 * The file npm will install as `husk`, read from package.json rather than assumed.
 *
 * Hardcoding `../dist/bin.js` here is what let 0.1.1 ship a `bin` that pointed at
 * a wrapper which exited 0 without running anything: these tests went on exercising
 * the module directly and stayed green while the published command did nothing.
 * Resolving it from the manifest means the suite always runs what a user runs.
 */
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const BIN = fileURLToPath(new URL('../' + PKG.bin.husk, import.meta.url));

/**
 * Skip when nothing is built; fail when something is built and the bin is absent.
 *
 * These are different states and must not look alike. `npm test` on a clean tree
 * legitimately has no `dist/`, so the subprocess suites below skip. But a `dist/`
 * that exists while `bin` names a file that does not is a package which installs a
 * command that cannot start -- and deciding to skip on that would hide exactly the
 * kind of defect this file is for.
 */
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const built = existsSync(DIST) && existsSync(BIN);

describe('packaging', () => {
  it('bin points at a file that exists once the package is built', () => {
    if (!existsSync(DIST)) return;
    expect(existsSync(BIN), `package.json bin.husk is ${PKG.bin.husk}, which does not exist`).toBe(true);
  });
});

/**
 * Remove a scratch directory, allowing for Windows.
 *
 * Every directory in this file has just had a subprocess running inside it, and
 * Windows keeps a handle on the working directory of a process it has already
 * reaped. `rmSync` then races the OS and loses with `EBUSY: resource busy or
 * locked, rmdir`. `maxRetries` is Node's answer: with `recursive`, it backs off
 * linearly and retries exactly the error set this race produces -- EBUSY,
 * EMFILE, ENFILE, ENOTEMPTY and EPERM.
 *
 * The failure was never a real one. Teardown runs after the assertions have
 * passed, so the test had already proved what it exists to prove -- and the job
 * went red anyway, on the one platform with the least coverage (#80, #63).
 * `force` alone does not help: it suppresses "does not exist", not "is busy".
 */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    // The retries above are the fix for the common case and were not enough:
    // this recurred on a Windows runner within hours of them landing. Ten
    // attempts over about five seconds is a guess at how long a handle is
    // held, and any number here is a guess.
    //
    // So teardown stops being able to fail the run. Everything this file
    // asserts has already passed by the time it gets here; the directory is
    // under the OS temp dir, and a CI runner is discarded whole. Trading a
    // few kilobytes nobody will look for against a red build that says
    // nothing about the code is not a close call.
    //
    // Reported rather than swallowed, so a leak that becomes a pattern is
    // visible instead of silent.
    console.warn(`[smoke] could not remove ${dir}: ${(err as Error).message}`);
  }
}

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'husk-cli-test-'));
});

afterAll(() => {
  removeDir(home);
});

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function husk(args: string[], opts: { cwd?: string; input?: string } = {}): Result {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? home,
    input: opts.input ?? '',
    env: { ...process.env, HUSK_HOME: home, NO_COLOR: '1', FORCE_COLOR: '' },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe.skipIf(!built)('the binary', () => {
  it('carries a shebang so it can be exec\'d directly', () => {
    expect(readFileSync(BIN, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  it('has a bin entry pointing at a file that exists', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    const target = fileURLToPath(new URL(`../${pkg.bin.husk}`, import.meta.url));
    expect(existsSync(target), `${pkg.bin.husk} is missing`).toBe(true);
  });

  it('starts fast enough to be invisible', () => {
    // Budgeted in CI so a dependency cannot silently regress it. Generous
    // against the ~95ms measured locally, because CI machines are slower --
    // it is a regression gate, not a benchmark.
    //
    // Best of three, because one wall-clock spawn inside a parallel suite
    // measures the machine as much as the binary: this failed at 1591ms and
    // 1600ms during a full `npm test` while passing every time it was run on
    // its own. A real regression is slow in all three runs; scheduler
    // contention is not, and a gate that fires on load is one people learn to
    // ignore.
    const runs = [0, 0, 0].map(() => {
      const t = Date.now();
      execFileSync(process.execPath, [BIN, '--help'], { stdio: 'ignore' });
      return Date.now() - t;
    });
    expect(Math.min(...runs), `startup times: ${runs.join('ms, ')}ms`).toBeLessThan(1500);
  });
});

describe.skipIf(!built)('help and version', () => {
  it('prints an overview for no arguments and exits 0', () => {
    const r = husk([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('USAGE');
    expect(r.stdout).toContain('husk doctor');
  });

  it('answers --help on stdout', () => {
    const r = husk(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('COMPUTERS');
  });

  it('answers a per-command --help without needing valid arguments', () => {
    const r = husk(['exec', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('husk exec <name|id> -- <command...>');
  });

  it('prints one bare line for --version, for release scripts to grep', () => {
    const r = husk(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps `version` stdout to one parseable line', () => {
    const r = husk(['version']);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.stderr).toContain('node');
  });
});

describe.skipIf(!built)('exit codes', () => {
  it('exits 2 on an unknown command, and suggests the right one', () => {
    const r = husk(['docter']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('did you mean `husk doctor`');
  });

  it('exits 2 on an unknown flag', () => {
    const r = husk(['ps', '--nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown flag --nope');
  });

  it('exits 2 when a required positional is missing', () => {
    const r = husk(['exec']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing <name|id>');
  });

  it('exits 2 when exec has a target but no command', () => {
    const r = husk(['exec', 'box']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('nothing to run');
  });

  it('exits 1 with a hint when a computer does not exist', () => {
    const r = husk(['exec', 'nope', '--', 'true']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no computer named "nope"');
    expect(r.stderr).toContain('hint:');
  }, 15_000);

  it('exits 1 with a hint when asked to remove a computer that does not exist', () => {
    const r = husk(['rm', 'anything']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no computer named');
  });

  it('exits 1, not 2, when a husk.yaml is missing', () => {
    const r = husk(['validate', 'no-such-file.yaml']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('hint:');
  });
});

describe.skipIf(!built)('--json purity', () => {
  it('puts nothing but JSON on stdout for ps', () => {
    const r = husk(['ps', '--json']);
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
  });

  it('puts nothing but JSON on stdout for models', () => {
    const r = husk(['models', '--json']);
    expect(r.status).toBe(0);
    expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
  });

  it('keeps stdout parseable even when the command fails', () => {
    const r = husk(['validate', 'missing.yaml', '--json']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toHaveProperty('error.code');
  });

  it('never emits ANSI when piped, even without NO_COLOR', () => {
    const r = spawnSync(process.execPath, [BIN, 'ps'], {
      encoding: 'utf8',
      env: { ...process.env, HUSK_HOME: home, NO_COLOR: '', FORCE_COLOR: '' },
    });
    expect(r.stdout).not.toMatch(new RegExp(String.fromCharCode(27) + '\\['));
  });
});

/**
 * Doctor against the real machine. Opt in with HUSK_INTEGRATION=1.
 *
 * Both tests below spawn `husk doctor`, which shells out to docker, podman and
 * wsl. That is worth doing deliberately and worth not doing on every commit: a
 * test whose result depends on how fast an external binary answers is not
 * testing what its name says. The shape assertions that used to sit here took
 * 890 seconds on a loaded machine and failed; they now run against fakes in
 * doctor.test.ts in 5ms.
 */
const integration = process.env.HUSK_INTEGRATION === '1';

describe.skipIf(!built || !integration)('doctor, against this machine', () => {
  it('always exits 0, because it reports rather than fails', () => {
    expect(husk(['doctor']).status).toBe(0);
  });

  it('puts nothing but JSON on stdout, spinner and all', () => {
    const r = husk(['doctor', '--json']);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report).toHaveProperty('providers');
    expect(report).toHaveProperty('selection');
    // The spinner and the probe chatter must all have gone to stderr.
    expect(r.stdout.startsWith('{')).toBe(true);
  });

  it('never claims isolation the local provider does not have', () => {
    const report = JSON.parse(husk(['doctor', '--json']).stdout);
    const local = report.providers.find((p: { name: string }) => p.name === 'local');
    expect(local.isolated).toBe(false);
  });
});

/**
 * The whole free path against a real machine.
 *
 * Everything above is argv and formatting; this is the product. It runs on the
 * `local` provider, which the build contract guarantees is always available, so
 * it works on a laptop with no Docker and no API key.
 */
describe.skipIf(!built)('the free path, end to end', () => {
  const name = 'vitest-smoke';

  it('creates, execs, lists, refuses an unconfirmed rm, then removes', (ctx) => {
    const up = husk(['up', name, '--provider', 'local', '--json']);
    expect(up.status, up.stderr).toBe(0);
    const info = JSON.parse(up.stdout);
    expect(info.provider).toBe('local');

    // On Windows the local provider runs commands through WSL. When WSL is
    // absent -- or has fallen over, which it does -- husk degrades to the host
    // shell and says so. POSIX redirection is meaningless there, so the honest
    // move is to skip rather than assert a Linux behaviour the machine cannot
    // provide. CI runs this on Linux, where it always executes.
    const shell = String(info.spec?.labels?.['husk.shell'] ?? '');
    if (shell === 'windows') {
      husk(['rm', name, '--yes']);
      ctx.skip('no Linux shell on this host (WSL missing or unhealthy)');
      return;
    }

    try {
      const exec = husk(['exec', name, '--json', '--', 'echo hi > a.txt; cat a.txt']);
      expect(exec.status).toBe(0);
      const result = JSON.parse(exec.stdout);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hi');

      // The child's exit code is husk's exit code.
      expect(husk(['exec', name, '--', 'exit 7']).status).toBe(7);

      const ps = husk(['ps', '--json']);
      expect(JSON.parse(ps.stdout).some((c: { name: string }) => c.name === name)).toBe(true);

      // The safety gate: destructive, non-interactive, no --yes.
      const unconfirmed = husk(['rm', name]);
      expect(unconfirmed.status).toBe(2);
      expect(unconfirmed.stderr).toContain('--yes');

      // Still there, because the refusal refused.
      expect(husk(['ps', '--json']).stdout).toContain(name);
    } finally {
      const rm = husk(['rm', name, '--yes']);
      expect(rm.status).toBe(0);
    }

    expect(husk(['ps', '--json']).stdout).not.toContain(name);
  }, 60_000);
});

describe.skipIf(!built)('init and validate round trip', () => {
  it('scaffolds a file that its own validator accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'husk-init-'));
    try {
      const init = husk(['init', 'round-trip', '--yes'], { cwd: dir });
      expect(init.status).toBe(0);
      expect(existsSync(join(dir, 'husk.yaml'))).toBe(true);

      const check = husk(['validate', 'husk.yaml', '--json'], { cwd: dir });
      expect(check.status).toBe(0);
      expect(JSON.parse(check.stdout).valid).toBe(true);
    } finally {
      removeDir(dir);
    }
  });

  it('refuses to clobber an existing file without --force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'husk-init-'));
    try {
      husk(['init', 'x', '--yes'], { cwd: dir });
      const second = husk(['init', 'x', '--yes'], { cwd: dir });
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('--force');
      expect(husk(['init', 'x', '--yes', '--force'], { cwd: dir }).status).toBe(0);
    } finally {
      removeDir(dir);
    }
  });
});
