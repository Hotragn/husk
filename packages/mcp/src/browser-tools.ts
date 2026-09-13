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
    name: 'browser_wait_for',
    description:
      'Wait until some text or a CSS selector appears on the page (or disappears, with gone). ' +
      'Use this after anything that loads content without navigating -- which on a modern site ' +
      'is most things. Waiting for a page load instead will return immediately and you will ' +
      'snapshot an empty page.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text to wait for.' },
        selector: { type: 'string', description: 'CSS selector to wait for, if you prefer.' },
        gone: { type: 'boolean', description: 'Wait for it to go away instead. Good for spinners.' },
        timeoutSec: { type: 'number', description: 'Give up after this long. Defaults to 15.' },
      },
    },
  },
  {
    name: 'browser_scroll',
    description:
      'Scroll the page, or bring one element into view. The snapshot lists the whole document, ' +
      'so an element can be listed and still be off screen; scroll to it before clicking if a ' +
      'click does not take. Also how you load more of an infinite-scroll page.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Bring this ref into view.' },
        to: { type: 'string', enum: ['top', 'bottom'], description: 'Jump to the top or bottom.' },
        by: { type: 'number', description: 'Pixels to scroll down; negative for up. Defaults to 600.' },
      },
    },
  },
  {
    name: 'browser_select',
    description:
      'Choose an option in a dropdown (a native <select>). Clicking one does nothing useful -- ' +
      'the menu is drawn by the operating system, not the page -- so use this instead. Matches ' +
      'the option by value or by its visible label.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A `ref` from browser_snapshot, on the <select>.' },
        value: { type: 'string', description: 'The option value, or the label you can see.' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'browser_upload',
    description:
      'Attach files to a file input. The paths are paths inside your computer, so write or ' +
      'download the file there first -- the browser is in the same machine as your filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A `ref` from browser_snapshot, on the file input.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths in the computer.' },
      },
      required: ['ref', 'files'],
    },
  },
  {
    name: 'browser_hover',
    description: 'Move the pointer over an element, for menus that only appear on hover.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'A `ref` from browser_snapshot.' } },
      required: ['ref'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Go back, go forward, or reload the current page.',
    inputSchema: {
      type: 'object',
      properties: { how: { type: 'string', enum: ['back', 'forward', 'reload'] } },
      required: ['how'],
    },
  },
  {
    name: 'browser_tabs',
    description:
      'List the open tabs, or switch to one. A link that opens in a new tab lands somewhere you ' +
      'are not looking, and every other browser tool keeps acting on the old page -- if a click ' +
      'seemed to do nothing, check here before concluding it failed.',
    inputSchema: {
      type: 'object',
      properties: {
        switchTo: { type: 'string', description: 'A targetId from a previous call, to switch to.' },
        open: { type: 'string', description: 'Open a new tab at this URL and switch to it.' },
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

/** url + snapshot as plain text, for replies that also say something else. */
async function stateText(computer: Computer, limit = 400): Promise<string> {
  const page = await browserFor(computer).activePage();
  return `now at ${await page.url()}\n\n${renderSnapshot(await page.snapshot({ limit }))}`;
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

    case 'browser_wait_for': {
      const timeoutMs = (typeof args.timeoutSec === 'number' ? args.timeoutSec : 15) * 1000;
      if (!args.text && !args.selector) return bad('pass text or selector');
      const page = await session.activePage();
      const res = await page.waitFor(
        {
          ...(typeof args.text === 'string' ? { text: args.text } : {}),
          ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
          ...(args.gone === true ? { gone: true } : {}),
        },
        timeoutMs,
      );
      const what = args.selector ? `selector ${String(args.selector)}` : `text ${JSON.stringify(args.text)}`;
      // A timeout is reported, not thrown: "it never appeared" is information
      // the model should act on, not an error that ends the attempt.
      return text(
        res.found
          ? `${what} ${args.gone === true ? 'went away' : 'appeared'} after ${res.waitedMs} ms`
          : `${what} did not ${args.gone === true ? 'go away' : 'appear'} within ${res.waitedMs} ms. ` +
              `Take a snapshot to see what is actually on the page.`,
      );
    }

    case 'browser_scroll': {
      const page = await session.activePage();
      await page.scroll({
        ...(typeof args.ref === 'string' ? { ref: args.ref } : {}),
        ...(args.to === 'top' || args.to === 'bottom' ? { to: args.to } : {}),
        ...(typeof args.by === 'number' ? { by: args.by } : {}),
      });
      return await pageState(computer);
    }

    case 'browser_select': {
      const ref = String(args.ref ?? '');
      if (!ref.trim()) return bad('ref is empty');
      const page = await session.activePage();
      const { selected } = await page.select(ref, String(args.value ?? ''));
      return text(redact(`selected "${selected}"\n\n${await stateText(computer)}`));
    }

    case 'browser_upload': {
      const ref = String(args.ref ?? '');
      const files = Array.isArray(args.files) ? args.files.map(String) : [];
      if (!ref.trim()) return bad('ref is empty');
      if (files.length === 0) return bad('files is empty');
      const page = await session.activePage();
      await page.setFiles(ref, files);
      return text(`attached ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`);
    }

    case 'browser_hover': {
      const ref = String(args.ref ?? '');
      if (!ref.trim()) return bad('ref is empty');
      await (await session.activePage()).hover(ref);
      // Hover exists to reveal something, so the new state is the useful reply.
      return await pageState(computer);
    }

    case 'browser_navigate': {
      const how = String(args.how ?? '');
      if (how !== 'back' && how !== 'forward' && how !== 'reload') return bad('how must be back, forward or reload');
      const page = await session.activePage();
      const { url } = await page.navigate(how);
      return text(redact(`now at ${url}\n\n${await stateText(computer)}`));
    }

    case 'browser_tabs': {
      if (typeof args.open === 'string' && args.open.trim()) {
        const opened = await session.newTab(args.open);
        return text(`opened and switched to ${opened.targetId} (${opened.url})`);
      }
      if (typeof args.switchTo === 'string' && args.switchTo.trim()) {
        const now = await session.switchTab(args.switchTo);
        return text(redact(`switched to ${now.url}\n\n${await stateText(computer)}`));
      }
      const tabs = await session.tabs();
      if (tabs.length === 0) return text('no tabs are open');
      return text(
        redact(
          tabs
            .map((t) => `${t.active ? '*' : ' '} ${t.targetId}  ${t.title || '(untitled)'}  ${t.url}`)
            .join('\n'),
        ),
      );
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
