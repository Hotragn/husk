import { describe, expect, it } from 'vitest';
import type { ComputerSpec } from '@husk/core';
import {
  type OciConfig,
  buildCopyIntoArgs,
  buildCopyOutOfArgs,
  buildExecArgs,
  buildRunArgs,
  decodeSpec,
  encodeSpec,
  parseLsLong,
  posixDirname,
  toContainerArgv,
} from './oci-common.js';

/**
 * These flags are the isolation claim.
 *
 * `husk doctor` tells a user that docker and podman give them kernel-level
 * isolation. That sentence is only true because of --cap-drop, --read-only,
 * --pids-limit, the memory ceiling and the non-root user, and none of those is
 * visible in any test that needs a container engine installed. So they are
 * asserted here, exactly, on argv.
 */

const docker: OciConfig = { binary: 'docker', provider: 'docker', rootless: false };
const podman: OciConfig = { binary: 'podman', provider: 'podman', rootless: true };

/** The argument that follows `flag`, or undefined. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

/** Every argument that follows any occurrence of `flag`. */
function valuesAfter(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 1] as string);
  return out;
}

function run(spec: ComputerSpec = {}, cfg: OciConfig = docker): string[] {
  return buildRunArgs(cfg, { cid: 'cmp_test', image: 'debian:bookworm-slim', workdir: '/work', spec });
}

describe('buildRunArgs', () => {
  it('starts a detached, named container from the resolved image', () => {
    const args = run();
    expect(args.slice(0, 4)).toEqual(['run', '-d', '--name', 'cmp_test']);
    expect(args.slice(-3)).toEqual(['debian:bookworm-slim', 'sleep', 'infinity']);
  });

  it('drops every capability and forbids regaining privilege', () => {
    const args = run();
    expect(valueAfter(args, '--cap-drop')).toBe('ALL');
    expect(valueAfter(args, '--security-opt')).toBe('no-new-privileges');
  });

  it('caps processes so a fork bomb hits its own ceiling', () => {
    expect(valueAfter(run(), '--pids-limit')).toBe('512');
  });

  /**
   * `mode=1777` is load-bearing, not cosmetic.
   *
   * Docker special-cases /tmp to 1777 and mounts every other tmpfs root-owned
   * 0755. The container runs as an unprivileged user, so without this the agent
   * got "Permission denied" writing to its own /work -- the one directory the
   * whole product is about. Measured on a real container before the fix:
   *   drwxr-xr-x 2 root root  /work   →  sh: cannot create /work/x.txt
   */
  it('mounts the root read-only and gives writable tmpfs only where work happens', () => {
    const args = run();
    expect(args).toContain('--read-only');
    expect(valuesAfter(args, '--tmpfs')).toEqual([
      '/tmp:rw,exec,nosuid,size=512m',
      '/run:rw,nosuid,size=16m',
      '/work:rw,exec,nosuid,mode=1777,size=2048m',
    ]);
  });

  it('sizes the workdir tmpfs from diskMb', () => {
    expect(valuesAfter(run({ diskMb: 512 }), '--tmpfs')).toContain('/work:rw,exec,nosuid,mode=1777,size=512m');
  });

  it('uses a named volume instead of a tmpfs when the spec asks to persist', () => {
    const args = run({ persist: true });
    expect(valueAfter(args, '-v')).toBe('husk-cmp_test:/work');
    expect(valuesAfter(args, '--tmpfs')).not.toContain('/work:rw,exec,nosuid,mode=1777,size=2048m');
  });

  it('defaults cpus and memory, and pins swap to memory so the limit bites', () => {
    const args = run();
    expect(args).toContain('--cpus=2');
    expect(args).toContain('--memory=2048m');
    expect(args).toContain('--memory-swap=2048m');
  });

  it('honours explicit cpus and memoryMb', () => {
    const args = run({ cpus: 4, memoryMb: 512 });
    expect(args).toContain('--cpus=4');
    expect(args).toContain('--memory=512m');
    expect(args).toContain('--memory-swap=512m');
  });

  it('runs as an unprivileged uid unless the spec names a user', () => {
    expect(valueAfter(run(), '-u')).toBe('1000:1000');
    expect(valueAfter(run({ user: 'husk' }), '-u')).toBe('husk');
  });

  it('sets the working directory', () => {
    expect(valueAfter(run(), '-w')).toBe('/work');
  });

  it('cuts the network off entirely for mode none', () => {
    expect(run({ network: { mode: 'none' } })).toContain('--network=none');
  });

  it('leaves the network alone for egress and full, which the tool layer enforces', () => {
    for (const mode of ['egress', 'full'] as const) {
      const args = run({ network: { mode } });
      expect(args.some((a) => a.startsWith('--network'))).toBe(false);
    }
  });

  it('mounts host paths read-only unless explicitly opted out', () => {
    const args = run({ mounts: [{ source: '/src/a', target: '/work/a' }] });
    expect(valuesAfter(args, '-v').some((v) => v.endsWith(':/work/a:ro'))).toBe(true);

    const rw = run({ mounts: [{ source: '/src/a', target: '/work/a', readonly: false }] });
    expect(valuesAfter(rw, '-v').some((v) => v.endsWith(':/work/a'))).toBe(true);
  });

  it('passes env through as -e pairs', () => {
    expect(valuesAfter(run({ env: { FOO: 'bar' } }), '-e')).toEqual(['FOO=bar']);
  });

  it('records the id, provider and round-trippable spec as labels', () => {
    const spec: ComputerSpec = { flavor: 'python', cpus: 1, labels: { 'husk.key': 'session-1' } };
    const args = run(spec);
    const labels = valuesAfter(args, '--label');
    expect(labels).toContain('husk.provider=docker');
    expect(labels).toContain('husk.id=cmp_test');
    expect(labels).toContain('husk.key=session-1');

    const encoded = labels.find((l) => l.startsWith('husk.spec='))?.slice('husk.spec='.length);
    expect(decodeSpec(encoded)).toEqual(spec);
  });

  it('gives podman exactly the same hardening as docker', () => {
    const d = run({ cpus: 3, memoryMb: 777 }, docker);
    const p = run({ cpus: 3, memoryMb: 777 }, podman);
    // The provider label is the only thing that may differ: the point of the
    // shared layer is that podman is not a second, drifting implementation.
    expect(p.map((a) => a.replace('husk.provider=podman', 'husk.provider=docker'))).toEqual(d);
  });
});

describe('buildExecArgs', () => {
  it('always keeps stdin open and targets the container', () => {
    const args = buildExecArgs(docker, { containerId: 'abc123', cmd: 'ls' });
    expect(args).toEqual(['exec', '-i', 'abc123', '/bin/sh', '-c', 'ls']);
  });

  it('adds -t only when a pty was asked for', () => {
    expect(buildExecArgs(docker, { containerId: 'c', cmd: 'ls' })).not.toContain('-t');
    const tty = buildExecArgs(docker, { containerId: 'c', cmd: 'ls', tty: true });
    expect(tty.slice(0, 3)).toEqual(['exec', '-i', '-t']);
  });

  it('places cwd, env and user before the container id', () => {
    const args = buildExecArgs(docker, {
      containerId: 'c',
      cmd: ['echo', 'hi'],
      cwd: '/work/sub',
      env: { A: '1', B: '2' },
      user: 'root',
    });
    expect(args).toEqual([
      'exec',
      '-i',
      '-w',
      '/work/sub',
      '-e',
      'A=1',
      '-e',
      'B=2',
      '-u',
      'root',
      'c',
      'echo',
      'hi',
    ]);
  });

  it('runs an argv array without a shell', () => {
    expect(toContainerArgv(['python', '-c', 'print(1)'])).toEqual(['python', '-c', 'print(1)']);
  });

  it('wraps a string in /bin/sh -c', () => {
    expect(toContainerArgv('a && b')).toEqual(['/bin/sh', '-c', 'a && b']);
  });

  it('refuses an empty argv rather than execing the container id', () => {
    expect(() => toContainerArgv([])).toThrow(/empty command array/);
  });
});

describe('buildCopyArgs', () => {
  it('copies into the container', () => {
    expect(buildCopyIntoArgs('abc', '/host/f.txt', '/work/f.txt')).toEqual([
      'cp',
      '/host/f.txt',
      'abc:/work/f.txt',
    ]);
  });

  it('copies out of the container', () => {
    expect(buildCopyOutOfArgs('abc', '/work/f.txt', '/host/f.txt')).toEqual([
      'cp',
      'abc:/work/f.txt',
      '/host/f.txt',
    ]);
  });
});

describe('parseLsLong', () => {
  it('reads types, sizes and names out of ls -lA', () => {
    const out = [
      'total 12',
      'drwxr-xr-x 2 husk husk 4096 Jan  1 00:00 src',
      '-rw-r--r-- 1 husk husk  123 Jan  1 00:00 main.py',
      'lrwxrwxrwx 1 husk husk    7 Jan  1 00:00 link -> main.py',
    ].join('\n');
    expect(parseLsLong(out, '/work')).toEqual([
      { name: 'src', path: '/work/src', type: 'dir', size: 4096 },
      { name: 'main.py', path: '/work/main.py', type: 'file', size: 123 },
      { name: 'link', path: '/work/link', type: 'symlink', size: 7 },
    ]);
  });

  it('keeps names with spaces intact', () => {
    const out = '-rw-r--r-- 1 husk husk 5 Jan  1 00:00 two words.txt';
    expect(parseLsLong(out, '/work')[0]?.name).toBe('two words.txt');
  });

  it('does not double the separator on a trailing slash', () => {
    const out = '-rw-r--r-- 1 husk husk 5 Jan  1 00:00 a.txt';
    expect(parseLsLong(out, '/work/')[0]?.path).toBe('/work/a.txt');
  });

  it('returns nothing for an empty listing', () => {
    expect(parseLsLong('total 0\n', '/work')).toEqual([]);
  });
});

describe('path and spec helpers', () => {
  it('takes a POSIX dirname whatever the host separator is', () => {
    expect(posixDirname('/work/a/b.txt')).toBe('/work/a');
    expect(posixDirname('/work')).toBe('/');
    expect(posixDirname('C:\\work\\a\\b.txt')).toBe('C:/work/a');
  });

  it('round-trips a spec through a label', () => {
    const spec: ComputerSpec = { flavor: 'node', env: { A: '1' }, network: { mode: 'egress', allow: ['*.npmjs.org'] } };
    expect(decodeSpec(encodeSpec(spec))).toEqual(spec);
  });

  it('treats a missing or corrupt spec label as an empty spec', () => {
    expect(decodeSpec(undefined)).toEqual({});
    expect(decodeSpec('not base64 json')).toEqual({});
  });
});
