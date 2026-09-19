import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBE_COMPUTER_INFO, PROBED_TOOLS } from './computer-info.js';

interface ResourceCase {
  name: string;
  layout: 'v2' | 'v1' | 'v1-combined' | 'missing';
  cpu?: string;
  memory?: string;
  hostCpu: string;
  hostMemoryKb?: string;
  expectedCpu: string;
  expectedMemory: string;
}

const RESOURCE_CASES: ResourceCase[] = [
  { name: 'v2 finite', layout: 'v2', cpu: '200000 100000', memory: '2147483648', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '2', expectedMemory: '2048MB' },
  { name: 'fractional CPU', layout: 'v2', cpu: '50000 100000', memory: '2147483648', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '0.5', expectedMemory: '2048MB' },
  { name: 'caps above host', layout: 'v2', cpu: '1200000 100000', memory: '17179869184', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '10', expectedMemory: '8192MB' },
  { name: 'v2 unlimited', layout: 'v2', cpu: 'max 100000', memory: 'max', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '10', expectedMemory: '8192MB' },
  { name: 'zero memory', layout: 'v2', cpu: 'max 100000', memory: '0', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '10', expectedMemory: '0MB' },
  { name: 'invalid v2', layout: 'v2', cpu: 'broken input', memory: 'broken', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '10', expectedMemory: '8192MB' },
  { name: 'v1 finite', layout: 'v1', cpu: '200000 100000', memory: '2147483648', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '2', expectedMemory: '2048MB' },
  { name: 'v1 combined controller', layout: 'v1-combined', cpu: '200000 100000', memory: '2147483648', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '2', expectedMemory: '2048MB' },
  { name: 'v1 unlimited', layout: 'v1', cpu: '-1 100000', memory: '9223372036854771712', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '10', expectedMemory: '8192MB' },
  { name: 'missing cgroup', layout: 'missing', hostCpu: '10', hostMemoryKb: '8388608', expectedCpu: '10', expectedMemory: '8192MB' },
  { name: 'missing host', layout: 'v2', cpu: '200000 100000', memory: '2147483648', hostCpu: '', expectedCpu: '2', expectedMemory: '2048MB' },
  { name: 'nothing readable', layout: 'missing', hostCpu: '', expectedCpu: '?', expectedMemory: '?' },
];

function resourceFields(output: string): { cpu: string | undefined; memory: string | undefined } {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(cpus|memory)\s+(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) fields.set(match[1], match[2]);
  }
  return { cpu: fields.get('cpus'), memory: fields.get('memory') };
}

describe('PROBE_COMPUTER_INFO', () => {
  it('answers the question computer_info tells a model to call it for', () => {
    // The bug this replaced: the agent's fallback reported kernel, cpus, memory,
    // disk and cwd, and nothing at all about what was installed -- while its own
    // description said to call it before assuming what is installed.
    expect(PROBE_COMPUTER_INFO).toContain('tools     ');
    const list = /for t in ([^;]+); do/.exec(PROBE_COMPUTER_INFO)?.[1];
    expect(list?.split(' ')).toEqual([...PROBED_TOOLS]);
  });

  it('probes with command -v, so it reports what can be run', () => {
    expect(PROBE_COMPUTER_INFO).toContain('command -v $t');
    expect(PROBE_COMPUTER_INFO).not.toMatch(/dpkg|rpm|apk info|pip list/);
  });

  it('keeps huskinfo\u2019s field order and column width', () => {
    // A model that learned the shape from a sandbox/ image should read the same
    // shape here. The width is huskinfo's: a 10-column key, then the value.
    const keys = [...PROBE_COMPUTER_INFO.matchAll(/"([a-z]+) {2,}/g)].map((m) => m[1]);
    expect(keys).toEqual(['os', 'kernel', 'arch', 'user', 'workdir', 'cpus', 'memory', 'disk', 'tools']);
    for (const line of PROBE_COMPUTER_INFO.split('; ')) {
      const [, key, pad] = /^(?:echo|printf) "([a-z]+)( +)/.exec(line) ?? [];
      if (key && pad) expect(key.length + pad.length).toBe(10);
    }
  });

  it('reports /work, which is where a computer actually keeps things', () => {
    expect(PROBE_COMPUTER_INFO).toContain('free on /work');
  });

  it('survives an image without free or df rather than printing a blank', () => {
    expect(PROBE_COMPUTER_INFO).toContain('else { print "?"; exit }');
    expect(PROBE_COMPUTER_INFO).toContain('END {if (NR<2) print "?"}');
  });

  it('prefers finite cgroup limits without rounding fractional CPUs up', () => {
    expect(PROBE_COMPUTER_INFO).toContain('/sys/fs/cgroup/cpu.max');
    expect(PROBE_COMPUTER_INFO).toContain('quota / period < host');
    expect(PROBE_COMPUTER_INFO).toContain('printf "%.6g\\n", quota / period');
    expect(PROBE_COMPUTER_INFO).toContain('/sys/fs/cgroup/memory.max');
    expect(PROBE_COMPUTER_INFO).toContain('limit < host');
  });

  it('keeps v1 compatibility and rejects its unlimited sentinel', () => {
    expect(PROBE_COMPUTER_INFO).toContain('cpu.cfs_quota_us');
    expect(PROBE_COMPUTER_INFO).toContain('memory.limit_in_bytes');
    expect(PROBE_COMPUTER_INFO).toContain('limit >= 1152921504606846976');
  });

  it('is safe to run inside `|| { ... ; }`', () => {
    // mcp wraps it that way. A trailing `;` or a stray newline would break the
    // brace group, and the failure would only show up on a real machine.
    expect(PROBE_COMPUTER_INFO).not.toMatch(/[;\s]$/);
    expect(PROBE_COMPUTER_INFO).not.toContain('\n');
  });
});

// The production command is Linux-specific. Windows and macOS package jobs do
// not provide the same /bin/sh and /etc/os-release contract as a Husk computer.
describe.skipIf(process.platform !== 'linux')('resource limit probe integration', () => {
  const huskinfo = readFileSync(new URL('../../../sandbox/huskinfo.sh', import.meta.url), 'utf8');

  it.each(RESOURCE_CASES)('$name is identical through the fallback and huskinfo paths', (testCase) => {
    const root = mkdtempSync(join(tmpdir(), 'husk-resource-'));
    try {
      const cgroup = join(root, 'cgroup');
      const meminfo = join(root, 'meminfo');
      mkdirSync(cgroup);
      if (testCase.layout === 'v2') {
        writeFileSync(join(cgroup, 'cpu.max'), `${testCase.cpu}\n`);
        writeFileSync(join(cgroup, 'memory.max'), `${testCase.memory}\n`);
      } else if (testCase.layout === 'v1' || testCase.layout === 'v1-combined') {
        const [quota, period] = testCase.cpu?.split(' ') ?? [];
        const cpuController = testCase.layout === 'v1' ? 'cpu' : 'cpu,cpuacct';
        mkdirSync(join(cgroup, cpuController));
        mkdirSync(join(cgroup, 'memory'));
        writeFileSync(join(cgroup, cpuController, 'cpu.cfs_quota_us'), `${quota}\n`);
        writeFileSync(join(cgroup, cpuController, 'cpu.cfs_period_us'), `${period}\n`);
        writeFileSync(join(cgroup, 'memory', 'memory.limit_in_bytes'), `${testCase.memory}\n`);
      }
      if (testCase.hostMemoryKb !== undefined) writeFileSync(meminfo, `MemTotal: ${testCase.hostMemoryKb} kB\n`);

      // Redirect resource files, supply a fixed host CPU count and disable the
      // network probe. Parsing and precedence remain the shell users run.
      const adapt = (script: string) => script
        .replaceAll('/sys/fs/cgroup', `'${cgroup}'`)
        .replaceAll('/proc/meminfo', `'${meminfo}'`)
        .replaceAll('nproc 2>/dev/null', `printf '%s\\n' '${testCase.hostCpu}'`)
        .replace('curl -fsS --max-time 2 -o /dev/null https://example.com 2>/dev/null', 'false');
      const run = (script: string) => execFileSync('/bin/sh', ['-s'], { input: script, encoding: 'utf8', timeout: 10_000 });
      const probeOutput = run(adapt(PROBE_COMPUTER_INFO));
      const imageOutput = run(adapt(huskinfo));
      const expected = { cpu: testCase.expectedCpu, memory: testCase.expectedMemory };

      expect(resourceFields(probeOutput)).toEqual(expected);
      expect(resourceFields(imageOutput)).toEqual(expected);
      // set -e must not stop a sandbox probe when host memory is unavailable.
      expect(imageOutput).toContain('disk      ');
      expect(imageOutput).toContain('tools     ');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
