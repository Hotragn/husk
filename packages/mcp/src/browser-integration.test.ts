import { spawnSync } from 'node:child_process';
import { closeBrowserFor } from '@husk-ai/browser';
import type { Computer } from '@husk-ai/core';
import type { ToolContent } from './tools.js';
import { DockerProvider, imagePlan } from '@husk-ai/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { callBrowserTool } from './browser-tools.js';

/**
 * The rendered browser, against a real engine.
 *
 * `full` could not run a browser on docker or podman for the whole life of the
 * flavor, and nothing in the suite noticed. It could not: the failure was a
 * missing shared library inside a container, after a download that reported
 * success, and that is not a thing a stubbed `cli` can have an opinion about.
 * It was found by hand, and without this it would regress by hand too.
 *
 * So this is the one test that wants a daemon, a network and a ~2 GB pull. It
 * is opt-in twice over, because the suite's contract is that it passes with no
 * Docker, no API key and no network:
 *
 *     HUSK_INTEGRATION=1 npx vitest run packages/mcp
 *
 * `docker info` is probed with a timeout rather than plainly, because a Docker
 * Desktop whose Linux engine is down does not answer and does not fail either
 * -- one Windows machine sat on that call for 86 minutes before returning.
 */
const integration = process.env.HUSK_INTEGRATION === '1';
const dockerAnswers =
  integration &&
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 }).status === 0;

describe.skipIf(!dockerAnswers)('browser_goto, on a real docker computer', () => {
  let computer: Computer | undefined;

  afterAll(async () => {
    if (!computer) return;
    await closeBrowserFor(computer.info.id).catch(() => {});
    await computer.destroy().catch(() => {});
  });

  it('starts Chromium on the flavor image and renders a page', async () => {
    computer = await new DockerProvider().create({
      name: 'husk-integration-full',
      flavor: 'full',
      idleTimeoutSec: 0,
    });

    // Why `full` is on Playwright's image at all: it carries Chromium's shared
    // libraries. Asserted here so a future image change that drops them is
    // caught as an image change, not as a browser mystery.
    expect(computer.info.image).toBe(imagePlan('full').primary);
    // A substitution would mean the machine is not the one the spec asked for,
    // and the browser conclusion below would be about a different image.
    expect(computer.info.imageFallback ?? null).toBeNull();

    const result = await callBrowserTool(computer, 'browser_goto', { url: 'https://example.com' }, 8_000);

    expect(result.isError ?? false).toBe(false);
    const body = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    // Chromium was downloaded at runtime and then actually started. The old
    // `full` image failed at exactly this point.
    expect(body).toContain('Example Domain');
  }, 900_000);
});

/**
 * `browser_status` exists to answer "will the next call cost me 111 MB?".
 * On a container provider the honest answer is "no, it will fail" -- the root
 * filesystem is read-only and the default image has nothing to download with
 * -- and the tool used to promise the download anyway (#122).
 */
describe('browser_status names the provider that cannot fetch a browser', () => {
  const textOf = (r: { content: ToolContent[] }): string =>
    r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

  function fakeComputer(provider: string): Computer {
    return {
      id: 'cmp_fake',
      info: { id: 'cmp_fake', provider, state: 'running', workdir: '/work' },
      exec: async () => ({ exitCode: 1, stdout: '', stderr: '', truncated: false, timedOut: false }),
      readTextFile: async () => '',
      listDir: async () => [],
    } as unknown as Computer;
  }

  it('warns on docker', async () => {
    const r = await callBrowserTool(fakeComputer('docker'), 'browser_status', {}, 4000);
    const out = textOf(r);
    expect(out).toContain('read-only');
    expect(out).toContain('--flavor python');
    expect(out).toContain('local');
  });

  it('stays quiet on local, where the browser is the confirmed case', async () => {
    const r = await callBrowserTool(fakeComputer('local'), 'browser_status', {}, 4000);
    const out = textOf(r);
    expect(out).toContain('111 MB');
    expect(out).not.toContain('read-only');
  });
});
