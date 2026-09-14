/**
 * Every tool husk advertises must be one it will actually run.
 *
 * This is the third time the same shape of bug has been found: a tool exists,
 * works, is tested, and is invisible to one caller because a list somewhere was
 * not updated. `listBuiltinTools()` in `@husk/agent` was missing six. This
 * package was missing all five browser tools, which meant the MCP client -- the
 * integration husk exists for -- was the only caller that could not open a page
 * in the browser running inside its own computer.
 *
 * So: assert the list and the dispatcher agree, in both directions.
 */

import { describe, expect, it } from 'vitest';
import { TOOLS, callTool } from './tools.js';
import { BROWSER_TOOLS } from './browser-tools.js';
import type { Computer } from '@husk/core';

/** Never reached: every assertion here stops at the dispatcher. */
const noComputer = {} as Computer;

describe('the MCP tool list', () => {
  it('advertises the browser', () => {
    const names = TOOLS.map((t) => t.name);
    for (const tool of ['browser_goto', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_status']) {
      expect(names).toContain(tool);
    }
  });

  it('advertises the whole browser module, not a subset someone remembered', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const tool of BROWSER_TOOLS) expect(names).toContain(tool.name);
  });

  it('has no duplicate names', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a description and an object schema', () => {
    // A model picks tools by description alone. An empty one is a tool that
    // will not be called, which is the same outcome as not shipping it.
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
  });

  it('routes every advertised tool somewhere', async () => {
    // "unknown tool" is the failure this catches: a name in the list with no
    // case in the switch. Any other error means it was routed and then failed
    // for want of a real computer, which is what should happen here.
    for (const tool of TOOLS) {
      const result = await callTool(noComputer, tool.name, {});
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text, tool.name).not.toMatch(/unknown tool/);
      expect(text, tool.name).not.toMatch(/unknown browser tool/);
    }
  });

  it('still reports a genuinely unknown name as unknown', () => {
    // The guard above is only worth anything if this still fails.
    return expect(callTool(noComputer, 'browser_teleport', {})).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/unknown tool/) }],
    });
  });

  it('rejects an empty ref before touching the browser', async () => {
    // Argument validation must not depend on a live Chromium, or a typo costs
    // a 111 MB download to discover.
    const result = await callTool(noComputer, 'browser_click', { ref: '  ' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'ref is empty' });
  });

  it('rejects an empty url before touching the browser', async () => {
    const result = await callTool(noComputer, 'browser_goto', { url: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'url is empty' });
  });
});
