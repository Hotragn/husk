import { Buffer } from 'node:buffer';
import { browserFor, inspectBrowserCapability } from '@husk-ai/browser';
import type { ActionOutcome, PageAction, SnapshotNode } from '@husk-ai/browser';
import type { Computer } from '@husk-ai/core';
import { redact } from '@husk-ai/core';
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
 * These have existed in `@husk-ai/agent` and in the console since the browser
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
    name: 'browser_run',
    description:
      'Do several page actions in ONE call, in order, stopping at the first that fails -- far ' +
      'faster than one tool call per action, so use it whenever you already know the next few ' +
      'steps. Each action is an object with "do": goto {url}; click {ref, or role and name}; ' +
      'fill {ref or role and name, text, submit}; wait {text, url or selector, gone, timeoutSec}; ' +
      'snapshot {limit}; screenshot {fullPage}. role and name match the accessibility tree, e.g. ' +
      '{"do":"click","role":"button","name":"Sign in"}. End with a snapshot to see where you ' +
      'landed. Never fill the user\'s passwords or codes yourself: call hand_off.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              do: { type: 'string', enum: ['goto', 'click', 'fill', 'wait', 'snapshot', 'screenshot'] },
              url: { type: 'string', description: 'goto: the URL. wait: text the URL must contain.' },
              ref: { type: 'string', description: 'click, fill: a ref from a snapshot, e.g. e42.' },
              role: { type: 'string', description: 'click, fill: an accessibility role, e.g. button, link, textbox.' },
              name: { type: 'string', description: 'click, fill: the accessible name, exactly.' },
              text: { type: 'string', description: 'fill: what to type. wait: visible text to wait for.' },
              submit: { type: 'boolean', description: 'fill: press Enter afterwards.' },
              selector: { type: 'string', description: 'wait: a CSS selector to wait for.' },
              gone: { type: 'boolean', description: 'wait: wait for it to go away instead.' },
              timeoutSec: { type: 'number', description: 'goto, wait: give up after this long.' },
              limit: { type: 'number', description: 'snapshot: cap the number of elements. Defaults to 400.' },
              fullPage: { type: 'boolean', description: 'screenshot: the whole document, not just the viewport.' },
            },
            required: ['do'],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'browser_script',
    description:
      'Run a short Python script against the current page when the next steps depend on what ' +
      'the page shows -- branch, loop over results, retry -- all in ONE call. It runs in its own ' +
      'process inside your computer, not on the host, and is stopped at timeoutSec. `page` has: ' +
      'goto(url), click(ref= or role=, name=), fill(text, ref= or role=, name=, submit=), ' +
      'wait_for_text(text, timeout=) / wait_for_url(part) / wait_for_selector(css) -> True or False, ' +
      'has_text(text), snapshot() -> list of {ref, role, name}, text(ref= or selector=), url(), title(); ' +
      'also sleep(seconds). A refused call raises PageError. Whatever you print comes back, and ' +
      'so does a JSON-able value you assign to `result`. Example:\n' +
      'if page.has_text("Accept cookies"):\n    page.click(role="button", name="Accept")\n' +
      'result = [n["name"] for n in page.snapshot() if n["role"] == "link"]\n' +
      'For steps that do not depend on the page, browser_run is simpler. Never type the ' +
      "user's passwords or codes from a script: call hand_off.",
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Python 3 source. `page`, `sleep` and `PageError` are already defined.' },
        timeoutSec: { type: 'number', description: 'Stop the script after this long. Defaults to 60, at most 600.' },
      },
      required: ['script'],
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
      'Never type the user\'s passwords or codes yourself: call hand_off. ' +
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
      'Whether this computer already has a browser, without installing one, and whether this ' +
      'provider can get one at all. Call it before browser_goto if you want to know whether the ' +
      'first call pays the ~111 MB download -- on a metered connection, or on a container ' +
      'provider that cannot perform the download, that is worth knowing first.',
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
    .map((n) => `${'  '.repeat(n.depth ?? 0)}${n.ref}  ${n.role}${n.name ? ` "${n.name}"` : ''}${n.value ? ` = "${n.value}"` : ''}`)
    .join('\n');
}

/** Long text cut in the middle, so the start and the end both survive. */
function clampLength(body: string, max: number): string {
  if (body.length <= max) return body;
  const half = Math.floor(max / 2);
  return `${body.slice(0, half)}\n[... ${body.length - max} characters cut ...]\n${body.slice(-half)}`;
}

/** The longest any one wait may be. */
export const MAX_WAIT_SEC = 600;

/**
 * A model's timeout in seconds, made safe: a finite positive number, at most
 * MAX_WAIT_SEC, else the default. Unchecked, `3000000` overflowed the host's
 * timer, which then fired at once and killed the driver.
 */
export function secondsArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_WAIT_SEC) : fallback;
}

const ACTION_NAMES: ReadonlySet<string> = new Set(['goto', 'click', 'fill', 'wait', 'snapshot', 'screenshot']);

/** The model's actions as `PageAction`s, or the reason one is not an action. */
function parseActions(raw: unknown): PageAction[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'actions must be a non-empty list';
  if (raw.length > 50) return 'at most 50 actions in one run';
  const out: PageAction[] = [];
  for (const [i, item] of raw.entries()) {
    const a = (item ?? {}) as Record<string, unknown>;
    const kind = String(a['do'] ?? '');
    const at = `action ${i + 1}`;
    if (!ACTION_NAMES.has(kind)) return `${at}: do must be one of ${[...ACTION_NAMES].join(', ')}`;
    const s = (k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
    // Left out when absent or unusable, so each action keeps its own default.
    const sec = secondsArg(a['timeoutSec'], 0);
    const ms = sec > 0 ? { timeoutMs: sec * 1000 } : {};
    const el = { ...(s('ref') ? { ref: s('ref') } : {}), ...(s('role') ? { role: s('role') } : {}), ...(s('name') ? { name: s('name') } : {}) };
    if ((kind === 'click' || kind === 'fill') && !el.ref && !el.role && !el.name) return `${at}: say which element, with ref or role and name`;
    if (kind === 'goto') {
      if (!s('url')?.trim()) return `${at}: goto needs a url`;
      out.push({ do: 'goto', url: s('url')!, ...ms });
    } else if (kind === 'click') out.push({ do: 'click', ...el });
    else if (kind === 'fill') out.push({ do: 'fill', ...el, text: s('text') ?? '', ...(a['submit'] === true ? { submit: true } : {}) });
    else if (kind === 'wait') {
      if (s('text') === undefined && s('url') === undefined && s('selector') === undefined) return `${at}: wait needs text, url or selector`;
      out.push({
        do: 'wait',
        ...(s('selector') !== undefined ? { selector: s('selector') } : s('url') !== undefined ? { url: s('url') } : { text: s('text') }),
        ...(a['gone'] === true ? { gone: true } : {}),
        ...ms,
      });
    } else if (kind === 'snapshot') out.push({ do: 'snapshot', limit: typeof a['limit'] === 'number' ? a['limit'] : 400 });
    else out.push({ do: 'screenshot', ...(a['fullPage'] === true ? { fullPage: true } : {}) });
  }
  return out;
}

/** One line per action, what it did; a snapshot's tree under its line. */
function describeOutcome(a: PageAction, o: ActionOutcome, n: number): string {
  const what =
    a.do === 'goto' ? `goto ${a.url}`
    : a.do === 'click' || a.do === 'fill' ? `${a.do} ${a.ref ?? `${a.role ?? ''} ${a.name ? JSON.stringify(a.name) : ''}`.trim()}`
    : a.do === 'wait' ? `wait for ${a.selector ?? (a.url !== undefined ? `url ${JSON.stringify(a.url)}` : JSON.stringify(a.text))}${a.gone ? ' to go' : ''}`
    : a.do;
  if (o.skipped) return `${n}. ${what} -- skipped`;
  if (o.error) return `${n}. ${what} -- FAILED: ${o.error}`;
  const how =
    a.do === 'goto' ? `${o.loaded ? 'loaded' : 'load did not finish'}, now at ${o.url}`
    : a.do === 'click' ? `${o.ref}${o.navigated ? ', navigated' : ''}`
    : a.do === 'fill' ? `${o.ref}`
    : a.do === 'wait' ? `after ${o.waitedMs} ms`
    : a.do === 'snapshot' ? `at ${o.url}\n${renderSnapshot(o.nodes ?? [])}`
    : 'see the image';
  return `${n}. ${what} -- ${how}`;
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
      const timeoutSec = secondsArg(args.timeoutSec, 30);
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

    case 'browser_run': {
      const actions = parseActions(args.actions);
      if (typeof actions === 'string') return bad(actions);
      const outcomes = await session.run(actions);
      const lines = outcomes.map((o, i) => describeOutcome(actions[i]!, o, i + 1));
      const images = outcomes
        .filter((o) => o.data && Buffer.byteLength(o.data, 'base64') <= INLINE_IMAGE_LIMIT)
        .map((o) => ({ type: 'image' as const, data: o.data!, mimeType: 'image/png' }));
      if (outcomes.some((o) => o.data) && images.length < outcomes.filter((o) => o.data).length) {
        lines.push('(a screenshot was too large to return inline; use browser_screenshot to save it to a file)');
      }
      const failed = outcomes.some((o) => o.error);
      return { content: [{ type: 'text', text: redact(lines.join('\n')) }, ...images], ...(failed ? { isError: true } : {}) };
    }

    case 'browser_script': {
      const script = typeof args.script === 'string' ? args.script : '';
      if (!script.trim()) return bad('script is empty');
      if (script.length > 100_000) return bad('script is over 100 KB; keep it to the steps that need deciding');
      const out = await session.script(script, secondsArg(args.timeoutSec, 60));
      const parts = [`${out.error ? 'failed' : 'finished'} in ${out.ms} ms`];
      if (out.output) parts.push(`printed:\n${out.output.trimEnd()}${out.truncated ? '\n[output past 64 KB was dropped]' : ''}`);
      if (out.result !== null && out.result !== undefined) parts.push(`result: ${JSON.stringify(out.result, null, 2)}`);
      if (out.error) parts.push(out.error.trimEnd());
      const body = clampLength(redact(parts.join('\n\n')), maxTextBytes);
      return out.error ? bad(body) : text(body);
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
      const timeoutMs = secondsArg(args.timeoutSec, 15) * 1000;
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
      const found = await inspectBrowserCapability(computer);
      if (found.installed) {
        return text(
          `a browser is already installed: ${found.binary} (${found.source}${found.version ? `, ${found.version}` : ''}). browser_goto will not download anything.`,
        );
      }
      if (!found.readyToInstall) return text(`This computer cannot install a rendered browser yet: ${found.reason}${found.hint ? `\n${found.hint}` : ''}\nText-only browse remains a separate capability.`);
      return text(
        'No browser is installed. Python and known Chromium system dependencies passed preflight. ' +
          'The first browser_goto downloads about 95–111 MB into /work/.husk-browser. ' +
          'Network reachability and the downloaded binary are checked during setup; preflight does not guarantee launch.',
      );
    }

    default:
      return bad(`unknown browser tool: ${name}`);
  }
}
