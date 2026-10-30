import { describe, expect, it } from 'vitest';
import { COMPUTER_INSTRUCTIONS } from './server.js';
import { WORKSPACE_INSTRUCTIONS } from './workspace-tools.js';

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe('the instructions every chat pays for', () => {
  it('stay under 300 words, workspace and computer together', () => {
    expect(words(WORKSPACE_INSTRUCTIONS + '\n' + COMPUTER_INSTRUCTIONS)).toBeLessThan(300);
  });

  it('carry the tool-choice rules', () => {
    for (const rule of ['`browse`', '`browser_*`', '`shell`', 'browser_snapshot', 'retry once', '`hand_off`', 'CAPTCHA', 'credentials']) {
      expect(COMPUTER_INSTRUCTIONS).toContain(rule);
    }
  });
});
