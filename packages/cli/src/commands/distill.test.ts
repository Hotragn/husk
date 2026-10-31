import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ui from '../ui.js';
import { run } from './distill.js';

/**
 * What `husk distill` sets a bot to run on. Which CLIs are "installed" is set
 * by HUSK_CLAUDE_CLI and HUSK_CODEX_CLI, both always named, so what is on this
 * machine never decides a test. No model: the free path, which reads the chat.
 */
let dir = '';
let printed: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'husk-distill-'));
  writeFileSync(join(dir, 'claude'), '');
  vi.stubEnv('HUSK_HOME', join(dir, 'home'));
  vi.stubEnv('HUSK_CLAUDE_CLI', join(dir, 'claude'));
  vi.stubEnv('HUSK_CODEX_CLI', join(dir, 'no-codex-here'));
  writeFileSync(
    join(dir, 'chat.md'),
    [
      'User: Every morning, check that https://example.com answers, and tell me if it does not.',
      'Assistant: I checked it with curl from the computer: it answered 200.',
      'User: Good. Keep the answer to one line.',
      'Assistant: Up, 200.',
    ].join('\n'),
  );
  printed = [];
  vi.spyOn(ui, 'print').mockImplementation((...parts: unknown[]) => void printed.push(parts.join(' ')));
  vi.spyOn(ui, 'note').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const distill = (...more: string[]) => run([join(dir, 'chat.md'), '--no-model', '--out', join(dir, 'husk.yaml'), '--force', ...more]);
const written = () => readFileSync(join(dir, 'husk.yaml'), 'utf8');

describe('husk distill', () => {
  it('sets the bot to run on the Claude Code that is installed, under the person’s own login', async () => {
    expect(await distill()).toBe(0);
    expect(written()).toMatch(/engine:\s*\n\s+type: claude-code/);
    expect(written()).not.toContain('resume:');
    expect(printed.join('\n')).toContain('Claude Code, under your own login');
  });

  it("uses Husk's own engine when asked, or when no CLI is installed", async () => {
    expect(await distill('--engine', 'builtin')).toBe(0);
    expect(written()).not.toContain('engine:');
    vi.stubEnv('HUSK_CLAUDE_CLI', join(dir, 'no-claude-here'));
    expect(await distill()).toBe(0);
    expect(written()).not.toContain('engine:');
    expect(printed.join('\n')).toContain("Husk's own engine");
  });

  it('refuses an engine this chat cannot run on here, saying which it can', async () => {
    await expect(distill('--engine', 'codex')).rejects.toThrow(/--engine codex is not one this chat can run on here/);
  });
});
