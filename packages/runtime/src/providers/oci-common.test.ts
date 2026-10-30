import { describe, expect, it } from 'vitest';
import type { Availability, ComputerSpec, ProviderName } from '@husk-ai/core';
import {
  type OciConfig,
  buildCopyIntoArgs,
  buildCopyOutOfArgs,
  buildExecArgs,
  buildRunArgs,
  OciProvider,
  decodeSpec,
  encodeSpec,
  parseLsLong,
  posixDirname,
  toContainerArgv,
} from './oci-common.js';
import { REGISTRY, type ImagePlan, imagePlan } from '../images.js';

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
    // The provider label and docker's init are the only things that may differ:
    // the point of the shared layer is that podman is not a second, drifting
    // implementation.
    expect(p.map((a) => a.replace('husk.provider=podman', 'husk.provider=docker'))).toEqual(d.filter((a) => a !== '--init'));
  });

  it('runs an init as PID 1 on docker, so a stopped command leaves no zombies', () => {
    const args = run();
    expect(args).toContain('--init');
    expect(args.indexOf('--init')).toBeLessThan(args.indexOf('debian:bookworm-slim'));
    // Podman's init needs an optional package; a container that fails to start is worse.
    expect(run({}, podman)).not.toContain('--init');
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
    expect(tty.slice(0, 2)).toEqual(['exec', '-t']);
  });

  it('never pairs -t with -i, which the engine refuses when its own stdin is not a terminal', () => {
    // The console's Terminal asks for a tty and sends no input: -t alone runs.
    expect(buildExecArgs(docker, { containerId: 'c', cmd: 'ls', tty: true })).not.toContain('-i');
    // Input to write wins over the pty: a pipe cannot be a terminal.
    const piped = buildExecArgs(docker, { containerId: 'c', cmd: 'cat', tty: true, stdin: true });
    expect(piped.slice(0, 2)).toEqual(['exec', '-i']);
    expect(piped).not.toContain('-t');
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

/**
 * `pullable` decides which image a machine actually starts from, and it does it
 * by shelling out. A subclass that records the argv instead is the only way to
 * assert the candidate order without an engine installed.
 *
 * `pullable` is a real concern to test: with no mirror configured `primary` and
 * `fallback` are the same string, and the loop used to spend a second pull
 * learning what the first already said.
 */
class Probe extends OciProvider {
  readonly name: ProviderName = 'docker';
  readonly description = 'probe';
  readonly priority = 0;
  /** Every argv `pullable` would have run, in order. */
  readonly attempts: string[][] = [];

  /** `pullable` succeeds for an image in `local`, and only via `pull`. */
  constructor(private readonly local = new Set<string>()) {
    super(docker);
  }

  async isAvailable(): Promise<Availability> {
    return { available: true, isolated: true, isolationKind: 'kernel' };
  }

  protected override cli(args: string[]) {
    this.attempts.push(args);
    const image = args[args.length - 1] as string;
    const settled =
      args[0] === 'pull' && this.local.has(image)
        ? Promise.resolve({ stdout: '', stderr: '' })
        : Promise.reject(new Error(`no such image: ${image}`));
    return settled as ReturnType<OciProvider['cli']>;
  }

  pull(plan: ImagePlan) {
    return this.pullable(plan);
  }

  get fellBack() {
    return this.usedFallback;
  }
}

/** A mirror and a public image, the only shape where the two genuinely differ. */
function mirrored(): ImagePlan {
  return {
    primary: 'registry.example/husk-base:0.1.0',
    fallback: 'debian:bookworm-slim',
    installCmd: '',
    user: 'husk',
  };
}

/** What every flavor looks like unless someone sets HUSK_REGISTRY. */
function collapsed(): ImagePlan {
  return { primary: 'debian:bookworm-slim', fallback: 'debian:bookworm-slim', installCmd: '', user: 'husk' };
}

describe('pullable', () => {
  it('is what the default plan looks like, so the collapse is not hypothetical', () => {
    // Guarded: a developer with HUSK_REGISTRY exported has a mirror, and then
    // the two are legitimately different strings.
    if (REGISTRY) return;
    const plan = imagePlan('base');
    expect(plan.primary).toBe(plan.fallback);
  });

  it('spends one inspect and one pull when the two candidates collapse', async () => {
    const probe = new Probe();
    await expect(probe.pull(collapsed())).rejects.toThrow(/could not obtain an image/);
    expect(probe.attempts).toEqual([
      ['image', 'inspect', 'debian:bookworm-slim'],
      ['pull', '--quiet', 'debian:bookworm-slim'],
    ]);
  });

  it('names a collapsed image once, not twice, when nothing can be pulled', async () => {
    const probe = new Probe();
    await expect(probe.pull(collapsed())).rejects.toThrow(
      'could not obtain an image (tried debian:bookworm-slim)',
    );
  });

  it('still tries the mirror before the public image, and names both', async () => {
    const probe = new Probe();
    await expect(probe.pull(mirrored())).rejects.toThrow(
      'could not obtain an image (tried registry.example/husk-base:0.1.0, debian:bookworm-slim)',
    );
    expect(probe.attempts.map((argv) => argv[argv.length - 1])).toEqual([
      'registry.example/husk-base:0.1.0',
      'registry.example/husk-base:0.1.0',
      'debian:bookworm-slim',
      'debian:bookworm-slim',
    ]);
  });

  it('reports no fallback when the collapsed image is the one that works', async () => {
    const probe = new Probe(new Set(['debian:bookworm-slim']));
    expect(await probe.pull(collapsed())).toBe('debian:bookworm-slim');
    expect(probe.fellBack).toBe(false);
  });

  it('reports a fallback only when a real mirror miss sent it to the public image', async () => {
    const probe = new Probe(new Set(['debian:bookworm-slim']));
    expect(await probe.pull(mirrored())).toBe('debian:bookworm-slim');
    expect(probe.fellBack).toBe(true);
  });
});

/** A provider whose engine only builds: records each argv and each Dockerfile it is handed. */
class Builder extends OciProvider {
  readonly name: ProviderName = 'docker';
  readonly description = 'builder';
  readonly priority = 0;
  readonly argvs: string[][] = [];
  readonly dockerfiles: string[] = [];

  constructor(
    private readonly built = new Set<string>(),
    private readonly fails = '',
  ) {
    super(docker);
  }

  async isAvailable(): Promise<Availability> {
    return { available: true, isolated: true, isolationKind: 'kernel' };
  }

  protected override cli(args: string[]) {
    this.argvs.push(args);
    const tag = args[args.indexOf('-t') + 1] as string;
    const settled =
      args[0] === 'image'
        ? this.built.has(args[2] as string)
          ? Promise.resolve({ stdout: '', stderr: '' })
          : Promise.reject(new Error('no such image'))
        : this.fails
          ? Promise.reject(Object.assign(new Error('build failed'), { stderr: this.fails }))
          : Promise.resolve({ stdout: '', stderr: '' }).then((r) => (this.built.add(tag), r));
    settled.catch(() => undefined);
    return Object.assign(settled, { child: { stdin: { end: (text: string) => void this.dockerfiles.push(text) } } }) as unknown as ReturnType<OciProvider['cli']>;
  }

  bake(image: string, spec: ComputerSpec) {
    return this.withPackages(image, spec);
  }
}

describe('packages, built into an image of the computer’s own', () => {
  it('builds them FROM the computer’s image, as root, with nothing for context', async () => {
    const b = new Builder();
    const tag = await b.bake('debian:bookworm-slim', { packages: ['jq', 'curl'] });
    expect(tag).toMatch(/^husk-packages:[0-9a-f]{16}$/);
    expect(b.argvs[1]?.slice(0, 6)).toEqual(['build', '--quiet', '-t', tag, '-f', '-']);
    expect(b.dockerfiles).toEqual([
      'FROM debian:bookworm-slim\nUSER root\nRUN set -f; PKGS="curl jq"; apt-get update -qq && apt-get install -y --no-install-recommends $PKGS\n',
    ]);
  });

  it('builds a list once, whatever its order, and leaves a computer with none alone', async () => {
    const b = new Builder();
    const first = await b.bake('debian:bookworm-slim', { packages: ['jq', 'curl'] });
    expect(await b.bake('debian:bookworm-slim', { packages: ['curl', 'jq', 'jq'] })).toBe(first);
    expect(b.dockerfiles).toHaveLength(1);
    expect(await b.bake('debian:bookworm-slim', {})).toBe('debian:bookworm-slim');
    expect(await b.bake('python:3.12-slim', { flavor: 'python', packages: ['requests[socks]>=2.32,<3'] })).not.toBe(first);
  });

  it('refuses a name a shell or a Dockerfile would read as more, before anything runs', async () => {
    for (const bad of ['jq; rm -rf /', '$(id)', '`id`', 'a b', "it's", 'jq\nRUN id']) {
      const b = new Builder();
      await expect(b.bake('debian:bookworm-slim', { packages: [bad] })).rejects.toMatchObject({ code: 'E_SPEC_INVALID' });
      expect(b.argvs).toEqual([]);
    }
  });

  it('says what the build said when it fails, and makes no computer', async () => {
    const b = new Builder(new Set(), 'Reading package lists...\nE: Unable to locate package nosuchpkg');
    await expect(b.bake('debian:bookworm-slim', { packages: ['nosuchpkg'] })).rejects.toMatchObject({
      code: 'E_COMPUTER_FAILED',
      message: expect.stringContaining('Unable to locate package nosuchpkg'),
    });
  });
});

describe('parseStatsLine', () => {
  it('reads CPU and memory from docker stats output', async () => {
    const { parseStatsLine } = await import('./oci-common.js');
    expect(parseStatsLine('1.23%|12.5MiB / 1.94GiB\n')).toEqual({
      cpuPercent: 1.23,
      memoryBytes: Math.round(12.5 * 1024 ** 2),
      memoryLimitBytes: Math.round(1.94 * 1024 ** 3),
    });
    expect(parseStatsLine('150.5%|800kB / 2GB')).toEqual({ cpuPercent: 150.5, memoryBytes: 800_000, memoryLimitBytes: 2e9 });
  });

  it('leaves out what it cannot read instead of guessing', async () => {
    const { parseStatsLine } = await import('./oci-common.js');
    expect(parseStatsLine('--|-- / --')).toEqual({});
    expect(parseStatsLine('')).toEqual({});
  });
});
