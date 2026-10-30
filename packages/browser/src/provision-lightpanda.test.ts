import { describe, expect, it } from 'vitest';
import type { Computer, ExecResult } from '@husk-ai/core';
import { LIGHTPANDA_BINARY, LIGHTPANDA_BUILDS, LIGHTPANDA_VERSION, inspectBrowserCapability, provisionLightpanda } from './provision.js';

/**
 * A computer that answers the commands Lightpanda's install runs: whether the
 * pinned binary is there, what the machine is, the download, and the digest of
 * what landed. No network and no binary.
 */
function machine(opts: { cached?: boolean; uname?: string; probe?: Record<string, unknown>; digest?: string } = {}) {
  const commands: string[] = [];
  const computer = {
    info: { provider: 'docker' },
    async exec({ cmd }: { cmd: string }): Promise<ExecResult> {
      commands.push(cmd);
      let stdout = '';
      if (cmd.startsWith(`test -x ${LIGHTPANDA_BINARY}`)) stdout = opts.cached ? 'yes' : 'no';
      else if (cmd === 'uname -m') stdout = opts.uname ?? 'x86_64';
      else if (cmd.includes('libc_ver')) stdout = JSON.stringify(opts.probe ?? { system: 'Linux', libc: 'glibc', page: 4096 });
      else if (cmd.includes('hashlib')) stdout = `${opts.digest ?? LIGHTPANDA_BUILDS.x64.sha256}\n`;
      return { stdout, stderr: '', exitCode: 0, durationMs: 1, timedOut: false, truncated: false };
    },
  } as unknown as Computer;
  return { computer, commands };
}

describe('Lightpanda in a computer', () => {
  it('pins one release, by its published digest, for each architecture', () => {
    for (const build of Object.values(LIGHTPANDA_BUILDS)) {
      expect(build.url).toContain(`/releases/download/${LIGHTPANDA_VERSION}/`);
      expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('downloads the pinned build and moves it into place only once its digest matches', async () => {
    const { computer, commands } = machine();
    const said: string[] = [];
    expect(await provisionLightpanda(computer, { onProgress: (m) => said.push(m) })).toMatchObject({ binary: LIGHTPANDA_BINARY, source: 'downloaded', version: LIGHTPANDA_VERSION });
    const got = commands.findIndex((c) => c.includes(LIGHTPANDA_BUILDS.x64.url));
    const checked = commands.findIndex((c) => c.includes('hashlib'));
    const moved = commands.findIndex((c) => c.includes(`mv -f ${LIGHTPANDA_BINARY}.part ${LIGHTPANDA_BINARY}`));
    expect(got).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(got);
    expect(moved).toBeGreaterThan(checked);
    // Its licence and source are said as it downloads.
    expect(said.join('\n')).toMatch(/AGPL-3\.0, source at https:\/\/github\.com\/lightpanda-io\/browser/);
  });

  it('deletes a download whose digest does not match, and never runs it', async () => {
    const { computer, commands } = machine({ digest: '0'.repeat(64) });
    await expect(provisionLightpanda(computer)).rejects.toThrow(/did not match its published checksum/);
    expect(commands.some((c) => c === `rm -f ${LIGHTPANDA_BINARY}.part`)).toBe(true);
    expect(commands.some((c) => c.includes('mv -f'))).toBe(false);
  });

  it('reuses the pinned build a computer already has, without downloading', async () => {
    const { computer, commands } = machine({ cached: true });
    expect(await provisionLightpanda(computer)).toMatchObject({ binary: LIGHTPANDA_BINARY, source: 'cached' });
    expect(commands.some((c) => c.includes('curl') || c.includes('urlretrieve'))).toBe(false);
  });

  it('says why a computer cannot run it, before downloading anything', async () => {
    for (const [probe, uname, why] of [
      [{ system: 'Linux', libc: '', page: 4096 }, 'x86_64', /needs glibc/],
      [{ system: 'Linux', libc: 'glibc', page: 65536 }, 'aarch64', /65536-byte pages/],
      [{ system: 'Darwin', libc: '', page: 4096 }, 'x86_64', /runs on Linux/],
    ] as const) {
      const { computer, commands } = machine({ probe, uname });
      await expect(provisionLightpanda(computer)).rejects.toThrow(why);
      expect(commands.some((c) => c.includes('curl'))).toBe(false);
      expect(await inspectBrowserCapability(computer, 'lightpanda')).toMatchObject({ engine: 'lightpanda', installed: false, readyToInstall: false, reason: expect.stringMatching(why) });
    }
  });

  it('reports the pinned build as installed for a status, without fetching anything', async () => {
    const { computer, commands } = machine({ cached: true });
    expect(await inspectBrowserCapability(computer, 'lightpanda')).toMatchObject({ engine: 'lightpanda', installed: true, binary: LIGHTPANDA_BINARY });
    expect(commands).toHaveLength(1);
  });
});
