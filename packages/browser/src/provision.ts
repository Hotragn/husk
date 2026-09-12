import { HuskError } from '@husk/core';
import type { Computer } from '@husk/core';

/**
 * Find, or install, a Chromium *inside the computer*.
 *
 * The binary has to live in the same machine as the shell and the filesystem,
 * for the same reason `browseInComputer` runs its fetch there: a browser on the
 * host would have a different IP, a different DNS view and an egress path the
 * computer's network policy does not govern. It would also be a different
 * filesystem, so a download the agent triggered would land somewhere the agent
 * cannot see.
 *
 * Nothing here shells out to a package manager. Ubuntu 26.04 ships `chromium`
 * as a snap shim with no apt candidate, and asking for snap inside a container
 * is a non-starter -- so the fallback is an unpacked build from a CDN.
 */

/** The two Linux architectures we can actually produce a binary for. */
export type BrowserArch = 'x64' | 'arm64';

export interface DownloadPlan {
  arch: BrowserArch;
  url: string;
  /** Directory under the cache root the zip is unpacked into. */
  dirName: string;
  /**
   * Path to the executable relative to the unpack directory.
   *
   * The two sources disagree about both the layout and the binary name, which
   * is exactly the sort of thing that rots silently, so it is data rather than
   * an `if` buried in the install path.
   */
  binaryPath: string;
  /** Roughly how big the download is, so a message can warn before it starts. */
  approxMb: number;
  source: 'chrome-for-testing' | 'playwright-cdn';
}

/**
 * Playwright's Chromium build we pin to on arm64.
 *
 * Chrome for Testing publishes linux64 only -- there is no linux-arm64 asset in
 * its manifest at all -- and Playwright's CDN is the only place a prebuilt
 * headless shell for that architecture exists. Pinned rather than "latest"
 * because the CDN has no manifest to ask.
 */
export const PLAYWRIGHT_CHROMIUM_REVISION = '1208';

export const CHROME_FOR_TESTING_MANIFEST =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

/** Where installs live inside the computer. Under /work so `persist: true` keeps them. */
export const CACHE_ROOT = '/work/.husk-browser';

const SYSTEM_CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'] as const;

/** `uname -m` output, and the handful of aliases that mean the same thing. */
export function normaliseArch(uname: string): BrowserArch {
  const a = uname.trim().toLowerCase();
  if (a === 'x86_64' || a === 'amd64' || a === 'x64') return 'x64';
  if (a === 'aarch64' || a === 'arm64' || a === 'aarch64_be') return 'arm64';
  throw new HuskError('E_NOT_IMPLEMENTED', `no prebuilt Chromium for ${uname.trim() || 'an unknown CPU'}`, {
    hint: 'install a system chromium in the computer (it will be found and reused), or use an x86-64 or arm64 machine',
    details: { uname: uname.trim() },
  });
}

/**
 * Pick the linux64 headless-shell asset out of the Chrome for Testing manifest.
 *
 * Kept pure so the shape of someone else's JSON is a unit test rather than a
 * 150 MB integration test.
 */
export function pickChromeForTestingAsset(manifest: unknown, channel = 'Stable'): { url: string; version: string } {
  const channels = (manifest as { channels?: Record<string, unknown> } | null)?.channels;
  const entry = channels?.[channel] as
    | { version?: unknown; downloads?: Record<string, unknown> }
    | undefined;
  const downloads = entry?.downloads?.['chrome-headless-shell'];
  const asset = Array.isArray(downloads)
    ? (downloads as Array<{ platform?: unknown; url?: unknown }>).find((d) => d.platform === 'linux64')
    : undefined;

  if (!asset || typeof asset.url !== 'string' || typeof entry?.version !== 'string') {
    throw new HuskError('E_PROVIDER_UNAVAILABLE', 'Chrome for Testing has no linux64 headless shell listed', {
      hint: `check ${CHROME_FOR_TESTING_MANIFEST} by hand -- the manifest shape may have changed`,
      details: { channel },
    });
  }
  return { url: asset.url, version: entry.version };
}

/**
 * Map an architecture onto a concrete download.
 *
 * `version` is only consulted on x64, where it comes from the manifest; arm64
 * is pinned to a revision because its CDN publishes no index.
 */
export function downloadPlanFor(
  arch: BrowserArch,
  opts: { url?: string; version?: string; revision?: string } = {},
): DownloadPlan {
  if (arch === 'arm64') {
    const rev = opts.revision ?? PLAYWRIGHT_CHROMIUM_REVISION;
    return {
      arch,
      url:
        opts.url ??
        `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${rev}/chromium-headless-shell-linux-arm64.zip`,
      dirName: `chromium-arm64-${rev}`,
      // Playwright's zip unpacks to chrome-linux/headless_shell -- a different
      // directory *and* a different executable name from the x64 asset.
      binaryPath: 'chrome-linux/headless_shell',
      approxMb: 111,
      source: 'playwright-cdn',
    };
  }

  const version = opts.version ?? 'stable';
  return {
    arch,
    url:
      opts.url ??
      `https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-headless-shell-linux64.zip`,
    dirName: `chromium-x64-${version}`,
    binaryPath: 'chrome-headless-shell-linux64/chrome-headless-shell',
    approxMb: 95,
    source: 'chrome-for-testing',
  };
}

/**
 * Names of shared libraries the dynamic linker could not resolve.
 *
 * "Chromium failed to start" is a bug report nobody can act on. "libnss3.so is
 * missing" is one line of apt away from fixed.
 */
export function parseMissingLibs(lddOutput: string): string[] {
  const missing = new Set<string>();
  for (const line of lddOutput.split('\n')) {
    const m = /^\s*(\S+)\s*=>\s*not found/.exec(line);
    if (m?.[1]) missing.add(m[1]);
  }
  return [...missing];
}

export interface ProvisionOptions {
  /** Called with human-readable progress. A 111 MB download deserves narration. */
  onProgress?: (message: string) => void;
  /** Skip looking for a system chromium. Mostly for reproducing the download path. */
  ignoreSystem?: boolean;
  signal?: AbortSignal;
  /** Seconds allowed for the download itself. Defaults to 600. */
  downloadTimeoutSec?: number;
}

export interface ProvisionResult {
  /** Absolute path, inside the computer, to an executable Chromium. */
  binary: string;
  arch: BrowserArch | 'unknown';
  source: 'system' | 'cached' | 'downloaded';
  /** Version string Chromium reported, when it would say. */
  version?: string;
}

async function sh(
  computer: Computer,
  cmd: string,
  opts: { timeoutSec?: number; signal?: AbortSignal } = {},
): Promise<{ code: number; out: string; err: string }> {
  const r = await computer.exec({
    cmd,
    timeoutSec: opts.timeoutSec ?? 60,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { code: r.exitCode, out: r.stdout, err: r.stderr };
}

/**
 * Unzip without `unzip`.
 *
 * A stock Ubuntu WSL has python3 and does not have unzip, and the husk images
 * are not guaranteed to have either -- but nothing that can run Chromium is
 * going to be missing python3, so this is the one that pays off.
 */
const UNZIP_SNIPPET = (zip: string, dest: string): string =>
  `python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" ${zip} ${dest}`;

/**
 * Is Chromium already here, without fetching anything?
 *
 * The console asks before offering the ~111 MB pre-flight. Offering to download
 * something a computer already has is a small lie, and it is the second thing a
 * returning user sees.
 *
 * Shares `findSystemChromium` and `findCached` with `provisionChromium`, so the
 * two can never disagree about what counts as present.
 */
export async function findInstalledChromium(
  computer: Computer,
  opts: { signal?: AbortSignal; ignoreSystem?: boolean } = {},
): Promise<ProvisionResult | null> {
  const { signal } = opts;
  if (!opts.ignoreSystem) {
    const found = await findSystemChromium(computer, signal);
    if (found) return found;
  }
  const unameRes = await sh(computer, 'uname -m', { signal, timeoutSec: 30 });
  return await findCached(computer, normaliseArch(unameRes.out || unameRes.err), signal);
}

export async function provisionChromium(
  computer: Computer,
  opts: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const say = opts.onProgress ?? ((): void => {});
  const signal = opts.signal;

  if (!opts.ignoreSystem) {
    const found = await findSystemChromium(computer, signal);
    if (found) {
      say(`using the system Chromium at ${found.binary}`);
      return found;
    }
  }

  const unameRes = await sh(computer, 'uname -m', { signal, timeoutSec: 30 });
  const arch = normaliseArch(unameRes.out || unameRes.err);

  // A cached copy is checked before the manifest is fetched, so a machine that
  // has already paid for the download never touches the network again.
  const cached = await findCached(computer, arch, signal);
  if (cached) {
    say(`reusing the Chromium already downloaded to ${cached.binary}`);
    return cached;
  }

  const plan = arch === 'x64' ? await resolveX64Plan(computer, signal, say) : downloadPlanFor('arm64');

  const dir = `${CACHE_ROOT}/${plan.dirName}`;
  const zip = `${CACHE_ROOT}/${plan.dirName}.zip`;
  const binary = `${dir}/${plan.binaryPath}`;

  say(
    `downloading Chromium for ${plan.arch} from ${plan.source} (~${plan.approxMb} MB). ` +
      `This happens once per computer; on a metered connection you may want to stop here.`,
  );

  await sh(computer, `mkdir -p ${CACHE_ROOT}`, { signal, timeoutSec: 30 });
  const dl = await download(computer, plan.url, zip, {
    timeoutSec: opts.downloadTimeoutSec ?? 600,
    ...(signal ? { signal } : {}),
  });
  if (!dl.ok) {
    throw new HuskError('E_PROVIDER_UNAVAILABLE', `could not download Chromium for ${plan.arch}`, {
      hint:
        'the computer needs egress to a CDN for this; check `husk exec <name> -- curl -sSI ' +
        `${plan.url}\`, or install a system chromium in the machine and husk will use that instead`,
      details: { url: plan.url, detail: dl.detail.slice(0, 500) },
    });
  }

  say(`unpacking ${plan.approxMb} MB into ${dir}`);
  await sh(computer, `rm -rf ${dir} && mkdir -p ${dir}`, { signal, timeoutSec: 60 });
  const unzip = await sh(computer, UNZIP_SNIPPET(zip, dir), { signal, timeoutSec: 300 });
  if (unzip.code !== 0) {
    throw new HuskError('E_PROVIDER_UNAVAILABLE', 'could not unpack the Chromium archive', {
      hint: 'this needs python3 in the computer (`unzip` is not enough of a given to rely on)',
      details: { stderr: unzip.err.slice(0, 500) },
    });
  }
  await sh(computer, `chmod +x ${binary} 2>/dev/null; rm -f ${zip}`, { signal, timeoutSec: 60 });

  const exists = await sh(computer, `test -x ${binary} && echo yes || echo no`, { signal, timeoutSec: 30 });
  if (!exists.out.includes('yes')) {
    throw new HuskError('E_PROVIDER_UNAVAILABLE', `the archive did not contain ${plan.binaryPath}`, {
      hint: 'the upstream zip layout changed; report this so the arch->layout map can be corrected',
      details: { dir, expected: plan.binaryPath, source: plan.source },
    });
  }

  await assertLinkable(computer, binary, signal);

  const version = await versionOf(computer, binary, signal);
  say(`Chromium ready: ${version ?? binary}`);
  return { binary, arch, source: 'downloaded', ...(version ? { version } : {}) };
}

async function findSystemChromium(
  computer: Computer,
  signal?: AbortSignal,
): Promise<ProvisionResult | null> {
  const probe = SYSTEM_CANDIDATES.map((c) => `command -v ${c} 2>/dev/null`).join('; ');
  const r = await sh(computer, `{ ${probe}; } | head -n 1`, { signal, timeoutSec: 45 });
  const path = r.out.trim().split('\n')[0]?.trim();
  if (!path) return null;

  // Ubuntu 26.04's `chromium` is a snap shim: it resolves, it is executable,
  // and running it without snapd fails in a way that looks like a husk bug.
  const version = await versionOf(computer, path, signal);
  if (!version) return null;

  return { binary: path, arch: 'unknown', source: 'system', version };
}

async function findCached(
  computer: Computer,
  arch: BrowserArch,
  signal?: AbortSignal,
): Promise<ProvisionResult | null> {
  const glob = arch === 'arm64' ? 'chrome-linux/headless_shell' : 'chrome-headless-shell-linux64/chrome-headless-shell';
  const r = await sh(
    computer,
    `ls -d ${CACHE_ROOT}/chromium-${arch}-*/${glob} 2>/dev/null | head -n 1`,
    { signal, timeoutSec: 30 },
  );
  const binary = r.out.trim().split('\n')[0]?.trim();
  if (!binary) return null;

  const ok = await sh(computer, `test -x ${binary} && echo yes || echo no`, { signal, timeoutSec: 30 });
  if (!ok.out.includes('yes')) return null;

  const version = await versionOf(computer, binary, signal);
  return { binary, arch, source: 'cached', ...(version ? { version } : {}) };
}

async function resolveX64Plan(
  computer: Computer,
  signal: AbortSignal | undefined,
  say: (m: string) => void,
): Promise<DownloadPlan> {
  say('asking Chrome for Testing which build is current');
  const r = await sh(computer, `curl -fsSL --max-time 30 ${CHROME_FOR_TESTING_MANIFEST}`, {
    signal,
    timeoutSec: 60,
  });
  if (r.code !== 0 || !r.out.trim()) {
    // A pinned fallback is worse than the manifest but far better than nothing:
    // the manifest host being down should not mean no browser.
    say('the Chrome for Testing manifest was unreachable; falling back to the `stable` alias');
    return downloadPlanFor('x64');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(r.out) as unknown;
  } catch {
    return downloadPlanFor('x64');
  }
  const { url, version } = pickChromeForTestingAsset(manifest);
  return downloadPlanFor('x64', { url, version });
}

async function download(
  computer: Computer,
  url: string,
  dest: string,
  opts: { timeoutSec: number; signal?: AbortSignal },
): Promise<{ ok: boolean; detail: string }> {
  const curl = await sh(computer, `curl -fsSL --max-time ${opts.timeoutSec} -o ${dest} ${url}`, {
    timeoutSec: opts.timeoutSec + 30,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (curl.code === 0) return { ok: true, detail: '' };

  // 127 means there is no curl at all, which is a different problem from a
  // failed transfer and deserves a second attempt rather than a shrug.
  const py = await sh(
    computer,
    `python3 -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" ${url} ${dest}`,
    { timeoutSec: opts.timeoutSec + 30, ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  if (py.code === 0) return { ok: true, detail: '' };
  return { ok: false, detail: `${curl.err}\n${py.err}`.trim() };
}

async function assertLinkable(computer: Computer, binary: string, signal?: AbortSignal): Promise<void> {
  const r = await sh(computer, `ldd ${binary} 2>&1 || true`, { signal, timeoutSec: 60 });
  const missing = parseMissingLibs(r.out);
  if (missing.length === 0) return;

  throw new HuskError('E_PROVIDER_UNAVAILABLE', `Chromium is missing ${missing.length} shared librar${missing.length === 1 ? 'y' : 'ies'}`, {
    hint: `install them in the computer, e.g. \`apt-get install -y ${missing.join(' ')}\` (package names may differ)`,
    details: { missing, binary },
  });
}

async function versionOf(computer: Computer, binary: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = await sh(computer, `${binary} --version 2>/dev/null`, { signal, timeoutSec: 45 });
  const line = r.out.trim().split('\n')[0]?.trim();
  return r.code === 0 && line ? line : undefined;
}
