import { describe, expect, it } from 'vitest';
import { defaultSpec, parseSpec } from './spec.js';

/**
 * `computer.user` and `computer.labels`.
 *
 * `ComputerSpec` has carried both since the first release and the ssh and fly
 * providers read `labels` for their target and their app -- but the husk.yaml
 * schema had no way to say either, so the per-husk overrides that
 * `computers/providers.mdx` documents were unreachable from a file.
 */
describe('ComputerConfigSchema: user and labels', () => {
  it('accepts labels from a husk.yaml and keeps them verbatim', () => {
    const spec = parseSpec({
      name: 'deployer',
      computer: {
        provider: 'ssh',
        labels: { 'husk.ssh': 'deploy@build-box:2222', 'husk.ssh.key': '/keys/id_ed25519' },
      },
    });
    expect(spec.computer.labels).toEqual({
      'husk.ssh': 'deploy@build-box:2222',
      'husk.ssh.key': '/keys/id_ed25519',
    });
  });

  it('accepts a per-husk user', () => {
    expect(parseSpec({ name: 'as-root', computer: { user: 'root' } }).computer.user).toBe('root');
  });

  it('rejects non-string label values rather than coercing them', () => {
    expect(() => parseSpec({ name: 'bad', computer: { labels: { 'husk.fly.app': 7 } } })).toThrow();
  });

  it('leaves both absent when the file does not mention them', () => {
    const spec = defaultSpec('plain');
    expect(spec.computer).not.toHaveProperty('labels');
    expect(spec.computer).not.toHaveProperty('user');
  });
});
