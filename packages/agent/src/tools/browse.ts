import { HuskError, browseInComputer } from '@husk/core';
import type { BrowseLink } from '@husk/core';
import { defineTool, type AgentTool } from '../types.js';

/**
 * The agent's browser, inside the agent's computer.
 *
 * Same machine as the shell and the filesystem, so `browse` then `shell` then
 * `write_file` are three views of one place -- and a page fetched here is
 * subject to the policy declared in the husk.yaml.
 *
 * `fetch_url` now runs in the computer too, so the difference between the two is
 * about output rather than about machines: `browse` returns links as structured
 * data for navigating, `fetch_url` returns prose and is the better fit for a
 * JSON API response.
 */

interface BrowseResult {
  url: string;
  status: number;
  title: string;
  text: string;
  links: BrowseLink[];
  truncated: boolean;
  via: string;
}

export const browse = defineTool<{ url: string; maxBytes?: number; timeoutSec?: number }, BrowseResult>({
  name: 'browse',
  description:
    'Load a web page from inside your own computer and return its title, readable text and links. ' +
    'Use this instead of curl for reading pages: it strips the markup for you and respects this ' +
    'machine’s network policy.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http or https URL.' },
      maxBytes: {
        type: 'integer',
        description: 'Cap the page text. Defaults to 120000, which is plenty for an article.',
      },
      timeoutSec: { type: 'integer', description: 'Give up after this many seconds. Defaults to 30.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  needsComputer: true,

  async handler(input, ctx) {
    if (!ctx.computer) {
      throw new HuskError('E_TOOL_ERROR', 'browse needs a computer, and this husk has none', {
        hint: 'set computer.enabled: true in husk.yaml — every husk browsing path runs in the machine',
      });
    }

    const page = await browseInComputer(ctx.computer, {
      url: input.url,
      maxBytes: input.maxBytes ?? 120_000,
      timeoutSec: input.timeoutSec ?? 30,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return {
      url: page.url,
      status: page.status,
      title: page.title,
      text: page.text,
      // Trimmed hard: a news front page yields 130+ links and the full list
      // crowds out the article the model was sent to read.
      links: page.links.slice(0, 40),
      truncated: page.truncated,
      via: page.via,
    };
  },

  render(out) {
    const head = `${out.status} ${out.url}${out.title ? `\n${out.title}` : ''}`;
    const links = out.links.length
      ? `\n\nLinks (${out.links.length} shown):\n` + out.links.map((l) => `- ${l.text} -> ${l.href}`).join('\n')
      : '';
    return `${head}\n\n${out.text}${links}${out.truncated ? '\n\n[page truncated]' : ''}`;
  },
});

export const browserTools: AgentTool[] = [browse];
