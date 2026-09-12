import { Buffer } from 'node:buffer';
import { browserFor, findInstalledChromium } from '@husk/browser';
import type { SnapshotNode } from '@husk/browser';
import type { Computer } from '@husk/core';
import { redact } from '@husk/core';
import type { ToolDef, ToolResult } from './tools.js';

/**
 * The real browser, for MCP clients.
 *
 * `browse` fetches HTML and strips the tags, which is the right amount of
 * machinery for an article and no use at all for the half of the web that
 * renders nothing until its JavaScript runs -- there, `browse` returns an empty
 * shell and the model concludes the page is blank. These tools drive an actual
 * Chromium inside the same computer as the shell and the filesystem, so a login
 * survives across pages and the agent reads the page a person would see.
 *
 * These have existed in `@husk/agent` and in the console since the browser
 * landed, and were missing from here -- so the integration husk is named for,
 * an MCP client like Claude Code, was the one caller that could not reach them.
 *
 * Everything is addressed by `ref` from `browser_snapshot`, never by pixel
 * coordinates. A model clicking a coordinate it inferred from a screenshot will
 * eventually click the wrong thing, and the wrong thing is sometimes "Delete".
 */

/** A viewport PNG the model can actually look at; beyond this, only the path. */
const INLINE_IMAGE_LIMIT = 750 * 1024;

export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: 'browser_goto',
    description:
      'Open a URL in a real Chromium inside your computer and return the rendered text. ' +
      'Use this instead of `browse` when the page needs JavaScript to render, or when you ' +
      'need to stay logged in across several pages. First use on a machine downloads ' +
      'Chromium (~111 MB) and takes a minute; after that it is fast, and `browse` is still ' +
      'the cheaper choice for a plain article.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http or https URL.' },
        timeoutSec: { type: 'number', description: 'Give up waiting for load. Defaults to 30.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'List everything on the current page you can read or act on, each with a `ref`. ' +
      'Pass a ref to browser_click or browser_type. Take a fresh snapshot after anything ' +
      'that changes the page -- refs do not survive a navigation.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Cap the number of elements. Defaults to 400.' },
      },
    },
  },
  {
    name: 'browser_click',
    description:
      'Click the element with this ref, then return a fresh snapshot of whatever the page ' +
      'became. Refs come from browser_snapshot; there is deliberately no way to click a ' +
      'coordinate.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'A `ref` from browser_snapshot, e.g. e42.' } },
      required: ['ref'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type into the field with this ref, replacing what is already there. Set submit to ' +
      'press Enter afterwards. Returns a fresh snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A `ref` from browser_snapshot.' },
        text: { type: 'string', description: 'The text to type.' },
        submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Take a PNG of the current page. Saved into the computer, and returned inline when it ' +
      'is small enough to be worth the tokens. Good for checking a layout or showing a human ' +
      'what you see -- for deciding what to click, browser_snapshot is smaller and more exact.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the whole document, not just the viewport.' },
        path: { type: 'string', description: 'Where to write it. Defaults to /work/screenshot.png.' },
      },
    },
  },
  {
    name: 'browser_status',
    description:
      'Whether this computer already has a browser, without installing one. Call it before ' +
      'browser_goto if you want to know whether the first call pays the ~111 MB download -- ' +
      'on a metered connection that is worth knowing first.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(BROWSER_TOOLS.map((t) => t.name));

function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body.length ? body : '(no output)' }] };
}

function bad(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function renderSnapshot(nodes: SnapshotNode[]): string {
  if (nodes.length === 0) return 'the page exposes no accessible elements';
  return nodes
    .map((n) => `${n.ref}  ${n.role}${n.name ? ` "${n.name}"` : ''}${n.value ? ` = "${n.value}"` : ''}`)
    .join('\n');
}

/** url + snapshot: the shape every tool that acts on the page returns. */
async function pageState(computer: Computer, limit = 400): Promise<ToolResult> {
  const page = await browserFor(computer).activePage();
  const url = await page.url();
  return text(redact(`now at ${url}\n\n${renderSnapshot(await page.snapshot({ limit }))}`));
}

export async function callBrowserTool(
  computer: Computer,
  name: string,
  args: Record<string, unknown>,
  maxTextBytes: number,
): Promise<ToolResult> {
  const session = browserFor(computer);

  switch (name) {
    case 'browser_goto': {
      const url = String(args.url ?? '');
      if (!url.trim()) return bad('url is empty');
      const timeoutSec = typeof args.timeoutSec === 'number' ? args.timeoutSec : 30;
      const result = await session.goto(url, { timeoutMs: timeoutSec * 1000 });
      const page = await session.activePage();
      const head = [
        result.url,
        await page.title(),
        result.loaded ? '' : '[the load event never fired; this is what had rendered by the timeout]',
      ]
        .filter(Boolean)
        .join('\n');
      return text(redact(`${head}\n\n${await page.text(Math.min(maxTextBytes, 120_000))}`));
    }

    case 'browser_snapshot': {
      const limit = typeof args.limit === 'number' ? args.limit : 400;
      const page = await session.activePage();
      return text(redact(`${await page.url()}\n\n${renderSnapshot(await page.snapshot({ limit }))}`));
    }

    case 'browser_click': {
      const ref = String(args.ref ?? '');
      if (!ref.trim()) return bad('ref is empty');
      const page = await session.activePage();
      // Waits for a load only when the click started one. A click that opens a
      // menu used to cost a flat 5s waiting for an event that was never coming.
      await page.clickAndSettle(ref);
      return await pageState(computer);
    }

    case 'browser_type': {
      const ref = String(args.ref ?? '');
      if (!ref.trim()) return bad('ref is empty');
      const page = await session.activePage();
      await page.type(ref, String(args.text ?? ''));
      if (args.submit === true) {
        await page.press('Enter');
        await page.waitForLoad(10_000);
      }
      return await pageState(computer);
    }

    case 'browser_screenshot': {
      const fullPage = args.fullPage === true;
      const path = typeof args.path === 'string' && args.path.trim() ? args.path : '/work/screenshot.png';
      const page = await session.activePage();
      const data = await page.screenshot({ fullPage });
      const bytes = Buffer.from(data, 'base64');
      await computer.writeFile(path, bytes);

      const note = `wrote a ${fullPage ? 'full-page' : 'viewport'} screenshot to ${path} (${bytes.length} bytes)`;
      // A full-page PNG is routinely a megabyte, and a megabyte of base64 buys
      // the model little that a snapshot would not give it more precisely. A
      // viewport shot usually fits, and seeing the page is worth real tokens.
      if (bytes.length > INLINE_IMAGE_LIMIT) {
        return text(`${note}\n\nToo large to return inline; read it from that path if you need the pixels.`);
      }
      return {
        content: [
          { type: 'text', text: note },
          { type: 'image', data, mimeType: 'image/png' },
        ],
      };
    }

    case 'browser_status': {
      const found = await findInstalledChromium(computer).catch(() => null);
      return text(
        found
          ? `a browser is already installed: ${found.binary} (${found.source}${found.version ? `, ${found.version}` : ''}). browser_goto will not download anything.`
          : 'no browser yet. The first browser_goto on this computer downloads Chromium ' +
              '(~111 MB) into /work/.husk-browser and takes a minute; on a persistent machine ' +
              'that happens once.',
      );
    }

    default:
      return bad(`unknown browser tool: ${name}`);
  }
}
