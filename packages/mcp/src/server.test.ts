/**
 * What husk says to the model before anything else.
 *
 * The server's connect-time instructions open with "Husk gives you a Linux
 * computer", which is true for almost everyone and false on a Windows host
 * whose WSL is not working. This note is the only thing that corrects it, and
 * the model is the one party that cannot go and check: it never sees `husk
 * doctor`, it did not pick the provider, and it acts on this sentence.
 *
 * These assertions are about wording, which is unusual for a test. They are
 * here because the wording is the feature -- a note that names the shell
 * without naming the consequence sends a model into a retry loop against a
 * command that can never work.
 */
import { describe, expect, it } from 'vitest';
import type { ComputerInfo, ProviderName } from '@husk-ai/core';
import { isolationNote } from './server.js';

const info = (provider: ProviderName, labels?: Record<string, string>): ComputerInfo => ({
  id: 'cmp_test',
  name: 'test',
  provider,
  state: 'running',
  image: 'husk-base',
  workdir: '/work',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-01-01T00:00:00.000Z',
  spec: { provider, ...(labels ? { labels } : {}) },
});

describe('the note the model reads first', () => {
  it('does not hedge about a container', () => {
    expect(isolationNote(info('docker'))).toMatch(/isolated from the host/);
  });

  it('says when the computer cannot enforce the network policy it was given', () => {
    const offline = (provider: ProviderName) => ({ ...info(provider), spec: { provider, network: { mode: 'none' as const } } });
    expect(isolationNote(offline('docker'))).not.toMatch(/Note:/);
    expect(isolationNote(offline('ssh'))).toMatch(/Note: network mode "none" is not enforced on ssh/);
  });

  it('refuses to call a guarded directory a sandbox', () => {
    const note = isolationNote(info('local', { 'husk.shell': 'wsl:Ubuntu' }));
    expect(note).toMatch(/NOT a sandbox/);
    expect(note).toMatch(/real Linux via Ubuntu/);
  });

  it('does not claim the shell is confined when it is not', () => {
    // Shell commands on the local provider can read /etc/passwd and write
    // outside the workspace. "/work is jailed" told the model otherwise.
    const note = isolationNote(info('local', { 'husk.shell': 'posix' }));
    expect(note).not.toMatch(/jail/i);
    expect(note).toMatch(/file tools are confined to \/work/);
    expect(note).toMatch(/shell commands can still reach/);
  });

  describe('on a Windows host that could not give it Linux', () => {
    const broken = isolationNote(
      info('local', { 'husk.shell': 'windows', 'husk.degradation': 'wsl-broken' }),
    );
    const absent = isolationNote(
      info('local', { 'husk.shell': 'windows', 'husk.degradation': 'wsl-absent' }),
    );

    it('leads with the consequence, not the label', () => {
      // "on the Windows shell" is what it used to say. A model reads that and
      // still runs `ls -la /work`, because nothing told it not to.
      for (const note of [broken, absent]) {
        expect(note).toMatch(/NOT Linux/);
        expect(note).toMatch(/\$VAR does not expand/);
      }
    });

    it('warns about the silent failures, not just the loud one', () => {
      // Measured against the real cmd.exe: a missing command is loud and
      // recoverable, but `$VAR` and `'...'` produce a wrong answer at exit 0,
      // and nothing downstream can tell that it happened.
      for (const note of [broken, absent]) {
        expect(note).toMatch(/single quotes' are not quotes/);
        expect(note).toMatch(/exit 0/);
      }
    });

    it('does not claim unix tools are absent, because that depends', () => {
      // Git for Windows puts cat, sed, grep, chmod and uname on PATH, so
      // "POSIX commands are unavailable" is false on a developer machine --
      // the same category of error as overclaiming isolation, reversed.
      for (const note of [broken, absent]) {
        expect(note).toMatch(/may or may not be on PATH/);
      }
    });

    it('tells the model to report the problem rather than route around it', () => {
      // Silently switching to cmd.exe syntax is the worst outcome: the user
      // never learns their computer is degraded, and the husk they are
      // building stops being portable.
      for (const note of [broken, absent]) {
        expect(note).toMatch(/tell the user/i);
      }
    });

    it('carries the fix that matches the state', () => {
      expect(broken).toMatch(/wsl --shutdown/);
      expect(broken).not.toMatch(/wsl --install/);
      expect(absent).toMatch(/wsl --install/);
      expect(absent).not.toMatch(/wsl --shutdown/);
    });

    it('does not send the model to Docker as an escape hatch', () => {
      // Docker Desktop runs its engine inside WSL2, so on this host it is
      // down for the same reason. "Start Docker" here is a second dead end.
      for (const note of [broken, absent]) {
        expect(note).not.toMatch(/Start Docker for real isolation/);
        expect(note).toMatch(/engine runs inside WSL2/);
      }
    });

    it('still says the guardrails are not containment', () => {
      for (const note of [broken, absent]) expect(note).toMatch(/NOT a sandbox/);
    });
  });
});
