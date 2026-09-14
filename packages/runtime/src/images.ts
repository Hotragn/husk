import type { Flavor } from '@husk-ai/core';

/**
 * Flavor -> image, and how to install a package once you are inside one.
 *
 * Our own images are preferred because they bake in the non-root user, `huskinfo`,
 * and a writable `/work`. But nobody has pulled them on a fresh install, and a
 * product whose first run fails on a registry 404 is a product nobody runs twice --
 * so every flavor has a public upstream fallback that works today.
 */

export const REGISTRY = process.env.HUSK_REGISTRY ?? 'ghcr.io/husk-sh';
export const IMAGE_TAG = process.env.HUSK_IMAGE_TAG ?? '0.1.0';

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
  base: {
    primary: `${REGISTRY}/husk-base:${IMAGE_TAG}`,
    fallback: 'debian:bookworm-slim',
    installCmd: 'apt-get update -qq && apt-get install -y --no-install-recommends $PKGS',
    user: 'husk',
  },
  python: {
    primary: `${REGISTRY}/husk-python:${IMAGE_TAG}`,
    fallback: 'python:3.12-slim',
    // uv when it is there, pip otherwise. uv turns a 40s install into 2s, and a
    // slow install is a wasted agent turn.
    installCmd:
      'if command -v uv >/dev/null 2>&1; then uv pip install --system $PKGS; else pip install --no-cache-dir $PKGS; fi',
    user: 'husk',
  },
  node: {
    primary: `${REGISTRY}/husk-node:${IMAGE_TAG}`,
    fallback: 'node:22-slim',
    installCmd: 'npm install -g --no-fund --no-audit $PKGS',
    user: 'husk',
  },
  /**
   * The only flavor that can run the rendered browser.
   *
   * `@husk-ai/browser` downloads Chromium at runtime, but the binary links against
   * ~20 shared libraries that the slim images do not carry, and container
   * computers mount their root read-only so they cannot be added later. The
   * husk-full image bakes them in; the public fallback below does not, so on a
   * machine that cannot pull husk's own image the rendered browser still needs
   * `--provider local`.
   */
  full: {
    primary: `${REGISTRY}/husk-full:${IMAGE_TAG}`,
    fallback: 'debian:bookworm',
    installCmd: 'apt-get update -qq && apt-get install -y --no-install-recommends $PKGS',
    user: 'husk',
  },
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

export function installScript(flavor: Flavor | undefined, packages: string[]): string {
  if (!packages.length) return '';
  const pkgs = packages.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
  return `PKGS="${pkgs.replace(/"/g, '\\"')}"; ${imagePlan(flavor ?? 'base').installCmd}`;
}
