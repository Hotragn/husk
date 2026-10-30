import { HuskError } from '@husk-ai/core';
import type { Flavor } from '@husk-ai/core';

/**
 * Flavor -> image, and how to install a package once you are inside one.
 *
 * Every flavor names a public image that exists today, and husk publishes none
 * of its own. That is a decision, not an unfinished task: an image you publish
 * is an operating system you have promised to keep patched, and a stale one
 * carrying known CVEs that people pull because your README told them to is
 * worse than no image at all. Debian, Ubuntu and the Playwright team already do
 * that work; there is nothing here they do not do better.
 *
 * `HUSK_REGISTRY` is the escape hatch for anyone who does want their own -- an
 * air-gapped site, or somewhere that mirrors every image it runs. Set it and
 * husk prefers `<registry>/husk-<flavor>:<tag>` and falls back to the public
 * image if that pull fails. Left unset there is nothing to fall back from,
 * because the public image is the image.
 */

export const REGISTRY = process.env.HUSK_REGISTRY ?? '';
export const IMAGE_TAG = process.env.HUSK_IMAGE_TAG ?? '0.1.0';

/**
 * One flavor's plan.
 *
 * `primary` and `fallback` collapse to the same public image unless a mirror is
 * configured, so the common path is a single pull with no 404 to recover from.
 */
function publicPlan(flavor: string, image: string, installCmd: string): ImagePlan {
  return {
    primary: REGISTRY ? `${REGISTRY}/husk-${flavor}:${IMAGE_TAG}` : image,
    fallback: image,
    installCmd,
    user: 'husk',
  };
}

const APT = 'apt-get update -qq && apt-get install -y --no-install-recommends $PKGS';

export interface ImagePlan {
  /** Preferred image, pulled if present. */
  primary: string;
  /** Public image used when the primary cannot be pulled. */
  fallback: string;
  /** Shell snippet that installs the named packages, given `$PKGS`. */
  installCmd: string;
  /** The user our images run as. Upstream fallbacks vary, so this is advisory. */
  user: string;
}

const PLANS: Record<Flavor, ImagePlan> = {
  base: publicPlan('base', 'debian:bookworm-slim', APT),

  // uv when it is there, pip otherwise. uv turns a 40s install into 2s, and a
  // slow install is a wasted agent turn.
  python: publicPlan(
    'python',
    'python:3.12-slim',
    'if command -v uv >/dev/null 2>&1; then uv pip install --system $PKGS; else pip install --no-cache-dir $PKGS; fi',
  ),

  node: publicPlan('node', 'node:22-slim', 'npm install -g --no-fund --no-audit $PKGS'),

  /**
   * The only flavor that can run the rendered browser.
   *
   * `@husk-ai/browser` downloads Chromium at runtime, but the binary links
   * against ~20 shared libraries the slim images do not carry, and container
   * computers mount their root read-only, so they cannot be added afterwards.
   * That made the browser fail on docker and podman after a perfectly
   * successful 111 MB download -- the most expensive way to learn a library is
   * missing.
   *
   * Playwright's image is used because it already carries exactly that set, on
   * glibc, maintained by people who track Chromium's dependencies for a living.
   * It is heavier than a slim Debian, which is the trade: `full` is the flavor
   * you ask for when you want everything, and the browser is part of everything.
   */
  full: publicPlan('full', 'mcr.microsoft.com/playwright:v1.59.1-noble', APT),
};

export function imagePlan(flavor: Flavor = 'base'): ImagePlan {
  return PLANS[flavor] ?? PLANS.base;
}

/** An explicit `spec.image` always wins; otherwise the flavor decides. */
export function resolveImage(spec: { image?: string; flavor?: Flavor }): ImagePlan {
  const plan = imagePlan(spec.flavor ?? 'base');
  if (spec.image) return { ...plan, primary: spec.image, fallback: spec.image };
  return plan;
}

/**
 * A package as a package manager takes it: apt's `name=1.2`, pip's
 * `name[extra]>=1,<2`, npm's `@scope/name@^1`. One word, with no quote, `$`,
 * backtick or backslash: nothing a shell or a Dockerfile reads as more.
 */
const PACKAGE = /^[A-Za-z0-9@][\w@.+\-/:=~<>^,![\]]*$/;

/**
 * The shell that installs `packages` on a flavor's image, as root.
 *
 * The names are checked, not quoted: quoted inside `PKGS="..."` they reached
 * the package manager with their quotes on, and a `$(...)` in one ran. `set -f`
 * keeps a pip extra such as `name[socks]` from matching a file.
 */
export function installScript(flavor: Flavor | undefined, packages: string[]): string {
  if (!packages.length) return '';
  const bad = packages.find((p) => !PACKAGE.test(p));
  if (bad !== undefined) {
    throw new HuskError('E_SPEC_INVALID', `not a package: ${JSON.stringify(bad)}`, {
      hint: 'a package is a name, with a version if you like: curl, requests==2.32, @scope/tool@1',
    });
  }
  return `set -f; PKGS="${packages.join(' ')}"; ${imagePlan(flavor ?? 'base').installCmd}`;
}
