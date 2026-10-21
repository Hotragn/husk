#!/usr/bin/env node
// Start the packaged app (dist/*-unpacked) in smoke mode with a throwaway
// HUSK_HOME, and pass only if it started its bundled Husk and the console
// loaded. Runs the same on Windows, macOS and Linux (under xvfb-run there).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const dirs = readdirSync(dist).filter((d) => /unpacked$|^mac/.test(d));
const candidates = dirs.flatMap((d) => [
  join(dist, d, 'Husk.exe'),
  join(dist, d, 'Husk.app', 'Contents', 'MacOS', 'Husk'),
  join(dist, d, 'husk-desktop'),
]);
const exe = candidates.find((p) => existsSync(p));
if (!exe) throw new Error(`no packaged app under ${dist} (looked in ${dirs.join(', ') || 'nothing'})`);

const home = mkdtempSync(join(tmpdir(), 'husk-desktop-smoke-'));
try {
  const r = spawnSync(exe, [], { env: { ...process.env, HUSK_HOME: home, HUSK_DESKTOP_SMOKE: '1' }, timeout: 120_000, encoding: 'utf8' });
  const log = existsSync(join(home, 'desktop.log')) ? readFileSync(join(home, 'desktop.log'), 'utf8') : '';
  const daemon = existsSync(join(home, 'daemon.log')) ? readFileSync(join(home, 'daemon.log'), 'utf8') : '';
  console.log(`${exe}\nexit ${r.status}\n--- desktop.log\n${log}\n--- daemon.log\n${daemon}`);
  if (r.status !== 0 || !/SMOKE loaded Husk console/.test(log)) process.exit(1);
} finally {
  rmSync(home, { recursive: true, force: true });
}
