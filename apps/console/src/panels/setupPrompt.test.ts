import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupPrompt } from './setupPrompt';

describe('the setup prompt', () => {
  it('is the one the README gives, word for word', () => {
    // The repository's README: the first one up from here that sits beside `packages/`.
    let dir = process.cwd();
    while (!existsSync(join(dir, 'packages')) && dirname(dir) !== dir) dir = dirname(dir);
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain(setupPrompt());
  });

  it('names one app when given one', () => {
    const p = setupPrompt({ id: 'claude-code', name: 'Claude Code' });
    expect(p).toContain('--apps claude-code --yes');
    expect(p).toContain('adds Husk to Claude Code.');
  });
});
