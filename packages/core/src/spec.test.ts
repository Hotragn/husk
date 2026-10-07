import { describe, expect, it } from 'vitest';
import { defaultSpec, parseSpec, safeParseSpec, TriggerSchema } from './spec.js';

describe('runtime trigger validation', () => {
  it.each(['discord', 'slack', 'telegram'])('rejects the unwired %s trigger with an actionable error', (type) => {
    expect(() => parseSpec({ name: 'bot', triggers: [{ type }] })).toThrow(/not wired into the Husk server/);
    const result = safeParseSpec({ name: 'bot', triggers: [{ type }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toContain('triggers.0.type');
    // Standalone adapter consumers may still describe their own binding.
    expect(TriggerSchema.safeParse({ type }).success).toBe(true);
  });

  it('accepts every trigger the runtime mounts', () => {
    expect(() => parseSpec({ name: 'bot', triggers: [
      { type: 'cli' }, { type: 'http' }, { type: 'webhook', path: '/hook' },
      { type: 'cron', schedule: '0 * * * *', prompt: 'check' },
    ] })).not.toThrow();
  });
});

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
