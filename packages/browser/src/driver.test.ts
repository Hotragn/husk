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

/**
 * Each case here starts a real Python interpreter. Cold process start on a
 * loaded CI runner routinely passes vitest's 5s default -- this block went red
 * on `main` at 5468ms and on a changelog-only PR at 7881ms, neither of which
 * had touched it. The assertions are about what the driver prints, not how
 * fast an interpreter boots, so the budget is per-block and generous: a real
 * hang still fails, and a slow machine no longer does.
 */
describe.skipIf(!python)('driver.py, run for real', { timeout: 30_000 }, () => {
  const run = (input: string): { code: number; out: Record<string, unknown> } => {
    const r = spawnSync(python!, [join(here, 'driver.py')], { input, encoding: 'utf8' });
    return { code: r.status ?? -1, out: JSON.parse(r.stdout.trim()) as Record<string, unknown> };
  };

  it('keeps a script click’s dialog answer to that click, so a later call dismisses', () => {
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(here)})`,
      'import driver',
      'driver.act_click = lambda conn, sid, args, deadline: "clicked"',
      'class Conn: pass',
      'conn = Conn(); conn.events = []; conn.dialog_answer = None',
      'seen = [driver.script_call(conn, "s", "click", {"dialog": "accept"}, 0), conn.dialog_answer]',
      'try:',
      '    driver.script_call(conn, "s", "nothing", {}, 0)',
      'except driver.DriverError:',
      '    pass',
      'seen.append(conn.dialog_answer)',
      'print(json.dumps(seen))',
    ].join('\n');
    const r = spawnSync(python!, ['-c', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['clicked', 'accept', null]);
  });

  it('refuses a ref that no snapshot recorded, where the page could have recorded it', () => {
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(here)})`,
      'import driver',
      'class Conn:',
      '    def __init__(self, readable): self.readable = readable',
      '    def call(self, method, params, sid, deadline):',
      '        if not self.readable: raise driver.DriverError(driver.PROTOCOL, "no frame tree")',
      '        return {"frameTree": {"frame": {"id": "F", "loaderId": "L1"}}}',
      'out = []',
      'for step in ({"ref": "e42"}, {"ref": "f1e42"}):',
      '    try:',
      '        driver.locate(Conn(True), "s", step, 0)',
      '        out.append("resolved")',
      '    except driver.DriverError as exc:',
      '        out.append(exc.message)',
      // A page whose document cannot be read recorded no refs either: those are resolved, as before.
      'out.append(driver.locate(Conn(False), "s", {"ref": "e42"}, 0)["backend"])',
      'print(json.dumps(out))',
    ].join('\n');
    const r = spawnSync(python!, ['-c', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const [page, frame, unreadable] = JSON.parse(r.stdout) as [string, string, number];
    expect(page).toMatch(/e42 is from a snapshot this browser has no record of; take a fresh snapshot/);
    expect(frame).toMatch(/f1e42 is from a snapshot this browser has no record of/);
    expect(unreadable).toBe(42);
  });

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
