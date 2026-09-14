import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DRIVER_PATH, DRIVER_SOURCE } from './driver.js';

const here = dirname(fileURLToPath(import.meta.url));
const pySource = readFileSync(join(here, 'driver.py'), 'utf8').replace(/\r\n/g, '\n');

describe('the embedded driver', () => {
  it('is byte-identical to src/driver.py', () => {
    // The Python is embedded because the build is `tsc` and nothing else. That
    // makes a stale copy possible, so this is the thing that makes it loud:
    // run `node scripts/embed-driver.mjs` and this goes green again.
    expect(DRIVER_SOURCE).toBe(pySource);
  });

  it('lands under the browser cache, so `persist: true` keeps it', () => {
    expect(DRIVER_PATH).toBe('/work/.husk-browser/driver.py');
  });

  it('never widens Chromium’s bind address', () => {
    // A driver that runs inside the computer has no reason to ask for one, and
    // an unauthenticated CDP port that is reachable is a remote-code-execution
    // primitive. If this string ever appears, something has gone badly wrong.
    expect(DRIVER_SOURCE).not.toMatch(/--remote-debugging-address|'0\.0\.0\.0'|"0\.0\.0\.0"/);
    expect(DRIVER_SOURCE).toContain("'http://127.0.0.1:%d/json/version'");
  });
});

/**
 * `python3` is present in every husk flavour, but not necessarily on the host
 * running the test suite -- so this block proves the driver's own parsing and
 * error reporting where it can, and skips where it cannot. It never needs a
 * browser: every case here fails before a socket would be opened.
 */
const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['-c', 'pass']).status === 0);

describe.skipIf(!python)('driver.py, run for real', () => {
  const run = (input: string): { code: number; out: Record<string, unknown> } => {
    const r = spawnSync(python!, [join(here, 'driver.py')], { input, encoding: 'utf8' });
    return { code: r.status ?? -1, out: JSON.parse(r.stdout.trim()) as Record<string, unknown> };
  };

  it('compiles and reports a failure as JSON on a zero exit', () => {
    // Exit code is reserved for "the driver could not run"; a structured
    // failure is still a successful run of the driver, and the host side keys
    // off exactly that distinction.
    const { code, out } = run(JSON.stringify({ port: 1, timeoutMs: 3000, steps: [] }));
    expect(code).toBe(0);
    expect(out['ok']).toBe(false);
    expect(out['kind']).toBe('unreachable');
  });

  it('says so when it is handed input it cannot parse', () => {
    const { code, out } = run('not json at all');
    expect(code).toBe(0);
    expect(out).toMatchObject({ ok: false, kind: 'internal' });
  });
});
