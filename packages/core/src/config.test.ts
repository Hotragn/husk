import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, loadEnvFile } from './config.js';

const dirs: string[] = [];
function file(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'husk-config-'));
  dirs.push(dir);
  const at = join(dir, name);
  writeFileSync(at, text);
  return at;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('~/.husk/config.json', () => {
  it('is the defaults when there is none', () => {
    expect(loadConfig(join(tmpdir(), 'husk-no-such-dir', 'config.json'))).toEqual(DEFAULT_CONFIG);
  });

  it('sets what the docs say it sets, and makes model what auto means', () => {
    const cfg = loadConfig(file('config.json', JSON.stringify({ maxComputers: 16, maxCostUsd: 2, provider: 'podman', model: 'free', modelAliases: { fast: 'groq/llama-3.3-70b-versatile' } })));
    expect(cfg).toMatchObject({ maxComputers: 16, maxCostUsd: 2, provider: 'podman', model: 'free' });
    expect(cfg.modelAliases).toEqual({ auto: 'free', fast: 'groq/llama-3.3-70b-versatile' });
    // An auto entry of its own wins over model.
    expect(loadConfig(file('config.json', JSON.stringify({ model: 'free', modelAliases: { auto: 'local' } }))).modelAliases).toEqual({ auto: 'local' });
  });

  it('takes the browser a computer runs when it does not say: chrome, unless set to lightpanda', () => {
    expect(loadConfig(join(tmpdir(), 'husk-no-such-dir', 'config.json')).browser).toBe('chrome');
    expect(loadConfig(file('config.json', JSON.stringify({ browser: 'lightpanda' }))).browser).toBe('lightpanda');
    expect(() => loadConfig(file('config.json', JSON.stringify({ browser: 'firefox' })))).toThrow(/browser/);
  });

  it('refuses what it cannot read rather than run on a default nobody asked for', () => {
    expect(() => loadConfig(file('config.json', '{ "maxComputers": 16, }'))).toThrow(/config\.json is not valid JSON/);
    expect(() => loadConfig(file('config.json', '{ "maxComputers": "16" }'))).toThrow(/maxComputers/);
    expect(() => loadConfig(file('config.json', '{ "maxComputer": 16 }'))).toThrow(/maxComputer/);
  });
});

describe('~/.husk/.env', () => {
  it('fills in what the environment lacks, and leaves what it has', () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'from-the-shell' };
    const at = file('.env', ['# keys', 'export ANTHROPIC_API_KEY=sk-ant-1', 'OPENAI_API_KEY=from-the-file', 'GROQ_API_KEY="gsk 2" ', "HOST='a#b'", 'NOTE=plain # a comment', 'not a line'].join('\n'));
    expect(loadEnvFile(at, env)).toEqual(['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'HOST', 'NOTE']);
    expect(env).toEqual({ OPENAI_API_KEY: 'from-the-shell', ANTHROPIC_API_KEY: 'sk-ant-1', GROQ_API_KEY: 'gsk 2', HOST: 'a#b', NOTE: 'plain' });
  });

  it('is nothing when there is none', () => {
    expect(loadEnvFile(join(tmpdir(), 'husk-no-such-dir', '.env'), {})).toEqual([]);
  });
});
