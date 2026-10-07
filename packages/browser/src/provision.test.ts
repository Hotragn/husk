import { describe, expect, it } from 'vitest';
import { isHuskError } from '@husk-ai/core';
import type { Computer, ExecResult } from '@husk-ai/core';
import {
  PLAYWRIGHT_CHROMIUM_REVISION,
  downloadPlanFor,
  normaliseArch,
  parseMissingLibs,
  pickChromeForTestingAsset,
  provisionChromium,
  inspectBrowserCapability,
} from './provision.js';

function machine(preflight: { system: string; missing: string[] } | 'no-python', systemBrowser = false) {
  const commands: string[] = [];
  const computer = {
    info: { provider: 'docker' },
    async exec({ cmd }: { cmd: string }): Promise<ExecResult> {
      commands.push(cmd);
      let stdout = '';
      let exitCode = 0;
      if (cmd === 'uname -m') stdout = 'x86_64';
      else if (cmd.includes('command -v chromium') && systemBrowser) stdout = '/usr/bin/chromium';
      else if (cmd.includes('--version') && systemBrowser) stdout = 'Chromium 145';
      else if (cmd.includes('HUSK_BROWSER_PREFLIGHT')) {
        if (preflight === 'no-python') exitCode = 127;
        else stdout = JSON.stringify(preflight);
      } else if (!cmd.includes('command -v chromium') && !cmd.startsWith('ls -d ')) {
        throw new Error(`unexpected command: ${cmd}`);
      }
      return { stdout, stderr: exitCode ? 'python3: not found' : '', exitCode, durationMs: 1, timedOut: false, truncated: false };
    },
  } as unknown as Computer;
  return { computer, commands };
}

describe('browser prerequisite checks', () => {
  it('refuses missing shared libraries before a manifest or archive request', async () => {
    const { computer, commands } = machine({ system: 'Linux', missing: ['libnss3.so', 'libgbm.so.1'] });
    await expect(provisionChromium(computer)).rejects.toThrow(/no download was attempted/);
    expect(commands.some((cmd) => cmd.includes('curl ') || cmd.includes('urlopen(') || cmd.includes('urlretrieve('))).toBe(false);
    const capability = await inspectBrowserCapability(computer);
    expect(capability).toMatchObject({ installed: false, readyToInstall: false });
    if (!capability.installed && !capability.readyToInstall) expect(capability.hint).toContain('libnss3.so');
  });

  it('refuses a machine without the downloader and extraction runtime', async () => {
    const { computer } = machine('no-python');
    await expect(provisionChromium(computer)).rejects.toThrow(/Python 3/);
  });

  it('does not offer a Linux archive on another operating system', async () => {
    const { computer } = machine({ system: 'Darwin', missing: [] });
    expect(await inspectBrowserCapability(computer)).toMatchObject({ readyToInstall: false, reason: expect.stringContaining('needs Linux') });
  });

  it('reports passing local prerequisites without touching the network', async () => {
    const { computer, commands } = machine({ system: 'Linux', missing: [] });
    expect(await inspectBrowserCapability(computer)).toEqual({ installed: false, readyToInstall: true, arch: 'x64' });
    expect(commands.some((cmd) => cmd.includes('urlopen(') || cmd.includes('urlretrieve('))).toBe(false);
  });

  it('reuses a working system browser without requiring download prerequisites', async () => {
    const { computer, commands } = machine('no-python', true);
    expect(await provisionChromium(computer)).toMatchObject({ source: 'system', binary: '/usr/bin/chromium' });
    expect(commands.some((cmd) => cmd.includes('HUSK_BROWSER_PREFLIGHT'))).toBe(false);
  });
});

describe('normaliseArch', () => {
  it('accepts the names uname actually prints', () => {
    expect(normaliseArch('x86_64\n')).toBe('x64');
    expect(normaliseArch('amd64')).toBe('x64');
    expect(normaliseArch('aarch64\n')).toBe('arm64');
    expect(normaliseArch('arm64')).toBe('arm64');
  });

  it('refuses an architecture we have no binary for, and says which', () => {
    try {
      normaliseArch('riscv64');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isHuskError(err)).toBe(true);
      if (isHuskError(err)) {
        expect(err.code).toBe('E_NOT_IMPLEMENTED');
        expect(err.message).toContain('riscv64');
        expect(err.hint).toBeTruthy();
      }
    }
  });
});

describe('downloadPlanFor', () => {
  it('maps arm64 to the Playwright CDN and its layout', () => {
    const plan = downloadPlanFor('arm64');
    expect(plan.source).toBe('playwright-cdn');
    expect(plan.url).toContain('cdn.playwright.dev');
    expect(plan.url).toContain(`/${PLAYWRIGHT_CHROMIUM_REVISION}/`);
    expect(plan.url).toContain('chromium-headless-shell-linux-arm64.zip');
    // Different directory *and* a different binary name from the x64 asset.
    expect(plan.binaryPath).toBe('chrome-linux/headless_shell');
  });

  it('maps x64 to Chrome for Testing and its layout', () => {
    const plan = downloadPlanFor('x64', { version: '145.0.7632.0' });
    expect(plan.source).toBe('chrome-for-testing');
    expect(plan.url).toContain('chrome-headless-shell-linux64.zip');
    expect(plan.binaryPath).toBe('chrome-headless-shell-linux64/chrome-headless-shell');
    expect(plan.dirName).toBe('chromium-x64-145.0.7632.0');
  });

  it('never gives two architectures the same cache directory', () => {
    expect(downloadPlanFor('x64').dirName).not.toBe(downloadPlanFor('arm64').dirName);
  });

  it('pins arm64 by revision, because its CDN publishes no index', () => {
    expect(downloadPlanFor('arm64', { revision: '1300' }).url).toContain('/1300/');
  });
});

describe('pickChromeForTestingAsset', () => {
  const manifest = {
    channels: {
      Stable: {
        version: '145.0.7632.0',
        downloads: {
          'chrome-headless-shell': [
            { platform: 'mac-arm64', url: 'https://example.test/mac.zip' },
            { platform: 'linux64', url: 'https://example.test/linux64.zip' },
          ],
        },
      },
    },
  };

  it('finds the linux64 headless shell', () => {
    expect(pickChromeForTestingAsset(manifest)).toEqual({
      url: 'https://example.test/linux64.zip',
      version: '145.0.7632.0',
    });
  });

  it('fails loudly when linux64 is absent rather than downloading a mac build', () => {
    const noLinux = { channels: { Stable: { version: '1', downloads: { 'chrome-headless-shell': [] } } } };
    expect(() => pickChromeForTestingAsset(noLinux)).toThrow(/linux64/);
  });

  it('fails on a manifest whose shape changed', () => {
    expect(() => pickChromeForTestingAsset({})).toThrow();
    expect(() => pickChromeForTestingAsset(null)).toThrow();
  });

  it('has no linux-arm64 asset to find, which is why arm64 uses another source', () => {
    const arm = (manifest.channels.Stable.downloads['chrome-headless-shell'] as Array<{ platform: string }>).some(
      (d) => d.platform === 'linux-arm64',
    );
    expect(arm).toBe(false);
  });
});

describe('parseMissingLibs', () => {
  it('names every library the linker could not resolve', () => {
    const ldd = [
      '\tlinux-vdso.so.1 (0x0000ffff...)',
      '\tlibnss3.so => not found',
      '\tlibatk-1.0.so.0 => /usr/lib/libatk-1.0.so.0 (0x0000ffff...)',
      '\tlibgbm.so.1 => not found',
    ].join('\n');
    expect(parseMissingLibs(ldd)).toEqual(['libnss3.so', 'libgbm.so.1']);
  });

  it('is quiet when everything resolves', () => {
    expect(parseMissingLibs('\tlibc.so.6 => /lib/libc.so.6 (0x00)')).toEqual([]);
  });

  it('does not mistake a resolved path containing "not found" text', () => {
    expect(parseMissingLibs('\tlibfoo.so => /opt/not-found/libfoo.so (0x00)')).toEqual([]);
  });
});
