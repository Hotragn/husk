import { describe, expect, it } from 'vitest';
import type { AgentToolContext } from '../types.js';
import { browserTools } from './browse.js';
import { realBrowserTools } from './browser.js';

/**
 * The machine comes up on first use, so a run whose first tool is the browser
 * has no `ctx.computer` yet. These tools must ask for one rather than report
 * "this husk has none" on a husk that has one.
 */
describe('browser tools on a run whose computer is not up yet', () => {
  for (const tool of [...realBrowserTools, ...browserTools]) {
    it(`${tool.name} asks for the computer instead of failing`, async () => {
      const asked = new Error('acquireComputer was called');
      const ctx = { acquireComputer: () => Promise.reject(asked) } as unknown as AgentToolContext;
      const args = { url: 'https://example.com', ref: 'e1', text: 'x' };
      await expect(tool.handler(args, ctx)).rejects.toBe(asked);
    });
  }
});
