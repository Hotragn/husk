import { PROBE_COMPUTER_INFO, createLogger } from '@husk-ai/core';
import { describe, expect, it } from 'vitest';
import { FakeComputer, specFor } from '../test-support.js';
import type { AgentToolContext } from '../types.js';
import { computer_info } from './computer.js';

function contextFor(computer: FakeComputer): AgentToolContext {
  return {
    computer,
    log: createLogger({ level: 'silent' }),
    huskId: 'test-husk',
    runId: 'run_test',
    state: new Map(),
    emit: () => undefined,
    confirm: async () => false,
    acquireComputer: async () => computer,
    spec: specFor(),
    maxOutputBytes: 262_144,
    callId: 'call_test',
  };
}

/** `command -v huskinfo` answers `yes`, everything else answers with `out`. */
function machine(hasHuskinfo: boolean, out = 'info'): FakeComputer {
  return new FakeComputer({
    exec: (req) => {
      const cmd = String(req.cmd);
      if (cmd.includes('command -v huskinfo')) return { stdout: hasHuskinfo ? 'yes' : 'no' };
      return { stdout: out };
    },
  });
}

describe('computer_info', () => {
  it('asks what is installed on a machine with no huskinfo', async () => {
    // The whole bug: this path used to run `uname -a` and four echoes, and never
    // reported a single installed tool -- while the description below told the
    // model to call it before assuming what is installed.
    const c = machine(false);
    const out = (await computer_info.handler({}, contextFor(c))) as { source: string };

    expect(out.source).toBe('probe');
    // Guarded: `@husk-ai/core` resolves to dist here, so a stale build makes the
    // constant undefined and `toBe(undefined)` would pass against a broken tool.
    expect(typeof PROBE_COMPUTER_INFO).toBe('string');
    expect(c.execs[1]?.cmd).toBe(PROBE_COMPUTER_INFO);
    expect(String(c.execs[1]?.cmd)).toContain('tools     ');
  });

  it('prefers huskinfo where the image actually ships it', async () => {
    const c = machine(true);
    const out = (await computer_info.handler({}, contextFor(c))) as { source: string };

    expect(out.source).toBe('huskinfo');
    expect(c.execs[1]?.cmd).toBe('huskinfo');
  });

  it('promises only what the probe delivers', async () => {
    // A description that names facts the tool does not return is how the gap
    // stayed invisible. These are the fields PROBE_COMPUTER_INFO prints.
    for (const field of ['kernel', 'memory', 'disk', 'installed']) {
      expect(computer_info.description).toContain(field);
    }
  });
});
