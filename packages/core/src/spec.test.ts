import { describe, expect, it } from 'vitest';
import { defaultSpec, parseSpec } from './spec.js';

describe('runtime trigger validation', () => {
  it('accepts every trigger the runtime mounts', () => {
    expect(() => parseSpec({ name: 'bot', triggers: [
      { type: 'cli' }, { type: 'http' }, { type: 'webhook', path: '/hook' },
      { type: 'cron', schedule: '0 * * * *', prompt: 'check' },
      { type: 'discord' }, { type: 'slack' }, { type: 'telegram', allowlist: ['alice'] },
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

describe("a husk run on the person's own CLI", () => {
  const issues = (input: Record<string, unknown>): string[] => {
    try {
      parseSpec({ name: 'nightly', ...input });
      return [];
    } catch (err) {
      return ((err as { details?: { issues?: string[] } }).details?.issues ?? []) as string[];
    }
  };

  it('defaults to the builtin engine', () => {
    expect(parseSpec({ name: 'nightly' }).engine).toEqual({ type: 'builtin' });
  });

  it('continues a Claude Code chat by its session id, and only Claude Code', () => {
    const id = '4f1c2a9e-0b1d-4c3e-9a8f-1234567890ab';
    expect(parseSpec({ name: 'nightly', engine: { type: 'claude-code', resume: id } }).engine.resume).toBe(id);
    expect(issues({ engine: { type: 'codex', resume: id } })).toEqual([expect.stringContaining('engine.resume: resume continues a Claude Code chat')]);
    expect(issues({ engine: { type: 'claude-code', resume: '../../etc' } })).toEqual([expect.stringContaining('engine.resume')]);
  });

  it('refuses, when the husk is saved, what a CLI engine cannot keep', () => {
    expect(issues({ engine: { type: 'claude-code' }, guardrails: { approvalMode: 'ask' } })).toEqual([expect.stringContaining('without asking')]);
    expect(issues({ engine: { type: 'codex' }, guardrails: { denyCommands: ['rm'] } })).toEqual([expect.stringContaining('denyCommands')]);
    expect(issues({ engine: { type: 'codex' }, computer: { network: { mode: 'egress', allow: ['example.com'] } } })).toEqual([expect.stringContaining('allow or deny lists')]);
    expect(issues({ guardrails: { approvalMode: 'ask', denyCommands: ['rm'] } })).toEqual([]);
  });
});
