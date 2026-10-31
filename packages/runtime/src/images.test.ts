import { describe, expect, it } from 'vitest';
import { isHuskError } from '@husk-ai/core';
import type { Flavor } from '@husk-ai/core';
import { imagePlan, installScript, resolveImage } from './images.js';

/**
 * Which image each flavor pulls, and the shell that installs a computer's
 * packages on it. `fallback` is checked rather than `primary`, which a mirror
 * named by HUSK_REGISTRY replaces.
 */
describe('image plans', () => {
  it('gives each flavor its public image', () => {
    expect(imagePlan('base').fallback).toBe('debian:bookworm-slim');
    expect(imagePlan('python').fallback).toBe('python:3.12-slim');
    expect(imagePlan('node').fallback).toBe('node:22-slim');
    expect(imagePlan('full').fallback).toMatch(/^mcr\.microsoft\.com\/playwright:/);
    expect(imagePlan()).toEqual(imagePlan('base'));
  });

  it('falls back to base for a flavor it does not know', () => {
    expect(imagePlan('ruby' as Flavor)).toEqual(imagePlan('base'));
  });

  it('lets an explicit image win over the flavor, keeping the flavor’s way to install', () => {
    const custom = resolveImage({ image: 'ghcr.io/me/tools:1', flavor: 'node' });
    expect(custom).toMatchObject({ primary: 'ghcr.io/me/tools:1', fallback: 'ghcr.io/me/tools:1' });
    expect(custom.installCmd).toBe(imagePlan('node').installCmd);
    expect(resolveImage({ flavor: 'python' })).toEqual(imagePlan('python'));
    expect(resolveImage({})).toEqual(imagePlan('base'));
  });
});

describe('installScript', () => {
  it("installs with each flavor's own package manager", () => {
    expect(installScript('node', ['express'])).toBe('set -f; PKGS="express"; npm install -g --no-fund --no-audit $PKGS');
    expect(installScript('python', ['requests==2.32'])).toMatch(/^set -f; PKGS="requests==2\.32"; .*uv pip install --system \$PKGS.*pip install --no-cache-dir \$PKGS/);
    expect(installScript('base', ['curl', 'jq'])).toMatch(/^set -f; PKGS="curl jq"; apt-get update -qq && apt-get install -y/);
    // No flavor is base.
    expect(installScript(undefined, ['curl'])).toBe(installScript('base', ['curl']));
  });

  it('is nothing for no packages', () => {
    expect(installScript('node', [])).toBe('');
  });

  it('takes the shapes package managers use, and refuses anything a shell would read as more', () => {
    expect(() => installScript('python', ['name[socks]>=1,<2', '@scope/tool@^1', 'pkg=1.2'])).not.toThrow();
    for (const bad of ['two words', 'x"; rm -rf /', '$(id)', '`id`', 'a\\b', '']) {
      let code: string | undefined;
      try {
        installScript('base', [bad]);
      } catch (err) {
        code = isHuskError(err) ? err.code : 'not a HuskError';
      }
      expect(code, JSON.stringify(bad)).toBe('E_SPEC_INVALID');
    }
  });
});
