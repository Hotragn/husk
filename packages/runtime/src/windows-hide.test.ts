import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The shared Husk runs detached, with no console. On Windows, a console
 * program it starts without `windowsHide` gets a console window of its own,
 * and the desktop app asks it for the overview every 2 s: anyone with Docker
 * installed watched a window flash every 2 s, and on every file read or write.
 * No check in CI can see a window, so this one reads the source instead.
 */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CALLS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith('.ts') && !/\.test\.ts$|\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Lines that call a child_process function, or a promisified copy of one, without saying `windowsHide`. */
function unhidden(src: string): number[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name && CALLS.has(name)) names.add(alias ?? name);
    }
  }
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*promisify\((\w+)\)/g)) {
    if (m[1] && m[2] && names.has(m[2])) names.add(m[1]);
  }
  const lines: number[] = [];
  for (const name of names) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, 'g'))) {
      let depth = 0;
      let end = m.index + name.length;
      for (; end < src.length; end++) {
        if (src[end] === '(') depth++;
        else if (src[end] === ')' && --depth === 0) break;
      }
      // A method of the same name, `spawn(req: SpawnRequest): ComputerProcess {`, is not a call.
      if (/^\s*[:{]/.test(src.slice(end + 1, end + 40))) continue;
      if (!src.slice(m.index, end + 1).includes('windowsHide')) lines.push(src.slice(0, m.index).split('\n').length);
    }
  }
  return lines;
}

describe('child processes on Windows', () => {
  it('start with windowsHide in every package', () => {
    const found = sources(PACKAGES).flatMap((file) =>
      unhidden(readFileSync(file, 'utf8')).map((line) => `${relative(PACKAGES, file).replaceAll('\\', '/')}:${line}`),
    );
    expect(found).toEqual([]);
  });

  it('would catch a call that leaves it out', () => {
    const src = [
      "import { execFile, spawn } from 'node:child_process';",
      'const run = promisify(execFile);',
      "run('docker', ['ps'], { timeout: 5 });",
      "spawn('docker', ['ps'], { windowsHide: true });",
    ].join('\n');
    expect(unhidden(src)).toEqual([3]);
  });
});
