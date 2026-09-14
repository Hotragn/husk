import { computerSpecFor } from '@husk-ai/agent';
import { parseSpec } from '@husk-ai/core';
import { resolveFlyConfig, resolveSshSettings } from '@husk-ai/runtime';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { renderSpec } from './yaml.js';

/**
 * The whole hop, from the bytes of a husk.yaml to the value a provider reads.
 *
 * `computers/providers.mdx` promises that `labels."husk.ssh"` in a husk.yaml is
 * an alternative to `HUSK_SSH_TARGET`. Nothing tested that promise end to end,
 * and it was in fact false: `ComputerConfigSchema` had no `labels`, so zod
 * stripped it before the agent ever saw it. This is the test that would have
 * caught it -- it crosses core, agent and runtime in one line each, with no
 * environment variables set.
 */
const NO_ENV = {} as NodeJS.ProcessEnv;

function specFromYaml(yaml: string) {
  return parseSpec(parseYaml(yaml) as unknown);
}

describe('husk.yaml labels reach the provider', () => {
  it('ssh: labels."husk.ssh" becomes the ssh target', () => {
    const spec = specFromYaml(`
apiVersion: husk/v1
name: deployer
computer:
  provider: ssh
  labels:
    husk.ssh: deploy@build-box:2222
    husk.ssh.key: /keys/id_ed25519
`);

    const settings = resolveSshSettings(computerSpecFor(spec), NO_ENV);

    expect(settings).not.toBeNull();
    expect(settings?.target).toMatchObject({ user: 'deploy', host: 'build-box', port: 2222 });
    expect(settings?.keyPath).toBe('/keys/id_ed25519');
  });

  it('ssh: no labels and no environment means no target, not a broken one', () => {
    const spec = specFromYaml('apiVersion: husk/v1\nname: plain\n');
    expect(resolveSshSettings(computerSpecFor(spec), NO_ENV)).toBeNull();
  });

  it('survives the CLI\'s own husk.yaml writer, dotted keys and all', () => {
    // `renderSpec` is hand-rolled. A dotted key is legal YAML as a plain scalar
    // key, but nothing proved this writer emitted it that way.
    const spec = specFromYaml(`
apiVersion: husk/v1
name: deployer
computer:
  provider: ssh
  user: deploy
  labels:
    husk.ssh: deploy@build-box:2222
`);
    const rendered = renderSpec(spec);
    const reparsed = parseSpec(parseYaml(rendered) as unknown);

    expect(reparsed.computer.labels).toEqual({ 'husk.ssh': 'deploy@build-box:2222' });
    expect(reparsed.computer.user).toBe('deploy');
    expect(resolveSshSettings(computerSpecFor(reparsed), NO_ENV)?.target).toMatchObject({
      host: 'build-box',
      port: 2222,
    });
  });

  it('fly: labels."husk.fly.app" and ."husk.fly.region" become the fly config', () => {
    const spec = specFromYaml(`
apiVersion: husk/v1
name: burst
computer:
  provider: fly
  labels:
    husk.fly.app: husk-burst
    husk.fly.region: lhr
`);

    const cfg = resolveFlyConfig({ env: NO_ENV }, computerSpecFor(spec));

    expect(cfg.app).toBe('husk-burst');
    expect(cfg.region).toBe('lhr');
  });
});
