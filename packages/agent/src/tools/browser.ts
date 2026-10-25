import { Buffer } from 'node:buffer';
import { HuskError } from '@husk-ai/core';
import { browserFor, describeHappened } from '@husk-ai/browser';
import type { SnapshotNode } from '@husk-ai/browser';
import { defineTool, type AgentTool, type AgentToolContext } from '../types.js';

/**
 * A real browser, in the agent's own computer.
 *
 * `browse` fetches HTML and strips the tags. For an article that is the right
 * amount of machinery and it stays. But half the web renders nothing until its
 * JavaScript runs, and none of it lets you log in, so `browse` returns an empty
 * shell and the model concludes the page is blank. These tools drive an actual
 * Chromium: the page the agent reads is the page a person would see.
 *
 * Everything is addressed by `ref` from `browser_snapshot`, never by pixel
 * coordinates. A model that clicks a coordinate it inferred from a screenshot
 * will eventually click the wrong thing, and the wrong thing is sometimes
 * "Delete".
 */

/**
 * The machine comes up on first use, so a run whose first tool is the browser
 * has no `ctx.computer` yet. Acquiring it here is what the shell and file tools
 * already do; reading `ctx.computer` instead failed with "this husk has none".
 */
async function sessionOf(ctx: AgentToolContext): Promise<ReturnType<typeof browserFor>> {
  return browserFor(ctx.computer ?? (await ctx.acquireComputer()));
}

function renderSnapshot(nodes: SnapshotNode[]): string {
  if (nodes.length === 0) return 'the page exposes no accessible elements';
  return nodes
    .map((n) => `${'  '.repeat(n.depth ?? 0)}${n.ref}  ${n.role}${n.name ? ` "${n.name}"` : ''}${n.value ? ` = "${n.value}"` : ''}`)
    .join('\n');
}

export const browserGoto = defineTool<
  { url: string; timeoutSec?: number },
  { url: string; title: string; loaded: boolean; text: string; also: string[] }
>({
  name: 'browser_goto',
  description:
    'Open a URL in a real Chromium running inside your computer and wait for it to load. ' +
    'Use this rather than `browse` when the page needs JavaScript, or when you need to stay ' +
    'logged in across several pages. Returns the rendered text.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http or https URL.' },
      timeoutSec: { type: 'integer', description: 'Give up waiting for load after this. Defaults to 30.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  needsComputer: true,

  async handler(input, ctx) {
    const session = await sessionOf(ctx);
    const result = await session.goto(input.url, { timeoutMs: (input.timeoutSec ?? 30) * 1000 });
    const page = await session.activePage();
    return {
      url: result.url,
      title: await page.title(),
      loaded: result.loaded || Boolean(result.downloads?.length),
      text: await page.text(Math.min(ctx.maxOutputBytes, 120_000)),
      also: describeHappened(result),
    };
  },

  render(out) {
    const also = out.also.map((l) => `\n${l}`).join('');
    return `${out.url}\n${out.title}${out.loaded ? '' : '\n[load event never fired; showing what rendered so far]'}${also}\n\n${out.text}`;
  },
});

export const browserSnapshot = defineTool<{ limit?: number }, { url: string; nodes: SnapshotNode[] }>({
  name: 'browser_snapshot',
  description:
    'List what is on the current page: every element you can read or act on, each with a `ref`. ' +
    'Pass a ref to browser_click or browser_type. Take a fresh snapshot after anything that ' +
    'changes the page.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Cap the number of elements. Defaults to 400.' },
    },
    additionalProperties: false,
  },
  needsComputer: true,

  async handler(input, ctx) {
    const page = await (await sessionOf(ctx)).activePage();
    return { url: await page.url(), nodes: await page.snapshot({ limit: input.limit ?? 400 }) };
  },

  render(out) {
    return `${out.url}\n\n${renderSnapshot(out.nodes)}`;
  },
});

export const browserClick = defineTool<
  { ref: string; force?: boolean; dialog?: 'accept' | 'dismiss' },
  { url: string; nodes: SnapshotNode[]; also: string[] }
>({
  name: 'browser_click',
  description:
    'Click the element with this ref, then return a fresh snapshot of whatever the page became. ' +
    'Refs come from browser_snapshot; there is deliberately no way to click a coordinate. A click ' +
    'on something disabled, hidden, still moving or covered is refused, saying why; force clicks anyway.',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'A `ref` from browser_snapshot, e.g. e42.' },
      force: { type: 'boolean', description: 'Press at its centre without the checks. Defaults to false.' },
      dialog: { type: 'string', enum: ['accept', 'dismiss'], description: 'How to answer a confirm or a prompt this opens: dismiss (the default) or accept.' },
    },
    required: ['ref'],
    additionalProperties: false,
  },
  needsComputer: true,
  dangerous: true,

  async handler(input, ctx) {
    const page = await (await sessionOf(ctx)).activePage();
    // Waits for the load only when the click actually started one. Waiting
    // unconditionally cost a flat 5s on every click that opened a menu, which
    // is most of them.
    const happened = await page.clickAndSettle(input.ref, 5000, { force: input.force === true, ...(input.dialog ? { dialog: input.dialog } : {}) });
    return { url: await page.url(), nodes: await page.snapshot({ limit: 400 }), also: describeHappened(happened) };
  },

  render(out) {
    return `${out.also.map((l) => `${l}\n`).join('')}now at ${out.url}\n\n${renderSnapshot(out.nodes)}`;
  },
});

export const browserType = defineTool<
  { ref: string; text: string; submit?: boolean },
  { url: string; nodes: SnapshotNode[]; also: string[] }
>({
  name: 'browser_type',
  description:
    'Type text into the field with this ref, replacing whatever is already there. ' +
    'Set submit to press Enter afterwards.',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'A `ref` from browser_snapshot.' },
      text: { type: 'string' },
      submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
    },
    required: ['ref', 'text'],
    additionalProperties: false,
  },
  needsComputer: true,
  dangerous: true,

  async handler(input, ctx) {
    const page = await (await sessionOf(ctx)).activePage();
    const happened = await page.type(input.ref, input.text, { submit: input.submit === true });
    return { url: await page.url(), nodes: await page.snapshot({ limit: 400 }), also: describeHappened(happened) };
  },

  render(out) {
    return `${out.also.map((l) => `${l}\n`).join('')}now at ${out.url}\n\n${renderSnapshot(out.nodes)}`;
  },
});

export const browserScreenshot = defineTool<
  { fullPage?: boolean; path?: string },
  { path: string; bytes: number; fullPage: boolean }
>({
  name: 'browser_screenshot',
  description:
    'Save a PNG of the current page into your computer and return its path. ' +
    'Use it to check a layout or to show a human what you are looking at — for deciding what to ' +
    'click, browser_snapshot is both smaller and more reliable.',
  parameters: {
    type: 'object',
    properties: {
      fullPage: { type: 'boolean', description: 'Capture the whole document, not just the viewport.' },
      path: { type: 'string', description: 'Where to write it. Defaults to /work/screenshot.png.' },
    },
    additionalProperties: false,
  },
  needsComputer: true,

  async handler(input, ctx) {
    const session = await sessionOf(ctx);
    const page = await session.activePage();
    const data = await page.screenshot({ fullPage: input.fullPage === true });
    const bytes = Buffer.from(data, 'base64');
    const path = input.path ?? '/work/screenshot.png';
    // Written into the computer rather than returned inline: a full-page PNG is
    // routinely a megabyte, and a megabyte of base64 in the transcript buys the
    // model nothing it could not get from a snapshot.
    await session.computer.writeFile(path, bytes);
    return { path, bytes: bytes.length, fullPage: input.fullPage === true };
  },

  render(out) {
    return `wrote a ${out.fullPage ? 'full-page' : 'viewport'} screenshot to ${out.path} (${out.bytes} bytes)`;
  },
});

export const realBrowserTools: AgentTool[] = [
  browserGoto,
  browserSnapshot,
  browserClick,
  browserType,
  browserScreenshot,
];
