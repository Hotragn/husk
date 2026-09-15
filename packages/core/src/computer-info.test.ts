import { describe, expect, it } from 'vitest';
import { PROBE_COMPUTER_INFO, PROBED_TOOLS } from './computer-info.js';

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
    // These are the two probes that emit nothing instead of failing when the
    // binary is missing, which would otherwise render as `memory` with no value.
    expect(PROBE_COMPUTER_INFO).toContain('END {if (NR<2) print "?"}');
  });

  it('is safe to run inside `|| { ... ; }`', () => {
    // mcp wraps it that way. A trailing `;` or a stray newline would break the
    // brace group, and the failure would only show up on a real machine.
    expect(PROBE_COMPUTER_INFO).not.toMatch(/[;\s]$/);
    expect(PROBE_COMPUTER_INFO).not.toContain('\n');
  });
});
