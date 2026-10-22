import { HuskError } from '@husk-ai/core';
import { waitResultOf } from './cdp.js';
import type { CdpConnection, CdpParams, DriverStep, SendStep } from './cdp.js';

/**
 * The surface an agent actually needs from a page.
 *
 * Everything addressable is addressed by `ref`, never by coordinates.
 * Coordinates are how agents misclick: the model reads a screenshot, guesses a
 * pixel, the layout shifts by eight pixels and it clicks "Delete account"
 * instead of "Cancel". A `ref` comes from the accessibility tree the model was
 * just shown, and resolves back to the exact DOM node that produced it.
 */

export interface AxNodeLike {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
  parentId?: string;
  childIds?: string[];
}

export interface SnapshotNode {
  /** Handle to pass to `click` / `type`. Derived from the DOM node, so it survives a re-snapshot. */
  ref: string;
  role: string;
  name: string;
  value?: string;
  /** Nesting in the compact tree, 0 at the top. Absent from `flattenAxTree`, which has no tree. */
  depth?: number;
}

/** Roles worth showing even when they carry no accessible name. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'listbox',
  'textarea',
]);

/** Structural noise that tells a model nothing and crowds out the page. */
const SKIP_ROLES: ReadonlySet<string> = new Set([
  'none',
  'presentation',
  'generic',
  'GenericContainer',
  'InlineTextBox',
  'LineBreak',
  'RootWebArea',
]);

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

/**
 * Flatten `Accessibility.getFullAXTree` into a list a model can read.
 *
 * The raw tree is deeply nested, mostly ignored nodes, and routinely 3000
 * entries for a news homepage. A flat list of the things you could name or
 * click is both smaller and easier to act on.
 */
export function flattenAxTree(nodes: AxNodeLike[], opts: { limit?: number } = {}): SnapshotNode[] {
  const limit = opts.limit ?? 1000;
  const out: SnapshotNode[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (out.length >= limit) break;
    if (node.ignored) continue;

    const role = str(node.role?.value);
    if (!role || SKIP_ROLES.has(role)) continue;

    const name = str(node.name?.value).replace(/\s+/g, ' ').trim();
    const value = str(node.value?.value).replace(/\s+/g, ' ').trim();
    const interactive = INTERACTIVE_ROLES.has(role);
    if (!name && !value && !interactive) continue;

    // A backend node id is what `click` needs, and it is stable for as long as
    // the node is in the document -- so a ref taken from one snapshot still
    // works after the next one. Nodes without one are informational only, and
    // get an `a`-prefixed ref that click will refuse rather than mis-resolve.
    const ref =
      node.backendDOMNodeId !== undefined ? `e${node.backendDOMNodeId}` : `a${str(node.nodeId) || out.length}`;
    if (seen.has(ref)) continue;
    seen.add(ref);

    out.push({ ref, role, name, ...(value ? { value } : {}) });
  }

  return out;
}

/** Text roles. A text node is page text, so only an empty one is ever dropped. */
const TEXT_ROLES: ReadonlySet<string> = new Set(['StaticText', 'text']);

/** Pieces of text Chromium splits out of a text node: the node already carries them. */
const DROP_ROLES: ReadonlySet<string> = new Set(['InlineTextBox', 'LineBreak']);

/**
 * Nodes kept even when they are unnamed and empty, because what they are is
 * the information: a picture, a frame boundary, a list item or a table cell.
 */
const SEMANTIC_ROLES: ReadonlySet<string> = new Set([
  'image', 'img', 'graphics-document', 'SvgRoot', 'svg', 'canvas', 'Canvas', 'Iframe', 'IframePresentational',
  'listitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'main', 'navigation', 'banner', 'contentinfo',
  'complementary', 'form', 'search', 'dialog', 'alertdialog',
]);

/** Whitespace, NBSP and zero-width formatting characters count as no text at all. */
function clean(v: unknown): string {
  return str(v).replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
}

interface Built {
  node: SnapshotNode;
  children: Built[];
}

/**
 * `Accessibility.getFullAXTree` as a compact tree, in document order.
 *
 * The rules are ego-lite's (docs/native-snapshot-ref-requirement.md in
 * citrolabs/ego-lite, MIT, Copyright (c) 2026 CitroLabs): drop text that is
 * empty or only whitespace, drop an unnamed container left with no children,
 * and replace an unnamed container that has one child with that child. An
 * unnamed container with several children stays, because it is what keeps two
 * groups of siblings apart. Named nodes, interactive ones and the semantic
 * roles above always stay, so refs, order and frame boundaries survive, and
 * page text is never dropped for being non-interactive. One addition of
 * husk's: a lone text child that only repeats its parent's name is dropped,
 * since the parent's line already says it -- a link is one line, not two.
 *
 * A flat list of nodes with no `childIds` is a forest of leaves, so old
 * fixtures and partial trees still come out in order.
 */
export function compactAxTree(nodes: AxNodeLike[], opts: { limit?: number } = {}): SnapshotNode[] {
  const limit = opts.limit ?? 1000;
  const byId = new Map<string, AxNodeLike>();
  for (const n of nodes) if (n.nodeId !== undefined) byId.set(str(n.nodeId), n);
  const seen = new Set<AxNodeLike>();

  const build = (n: AxNodeLike, index: number): Built[] => {
    if (seen.has(n)) return [];
    seen.add(n);
    const role = str(n.role?.value);
    const kids = (n.childIds ?? []).flatMap((id, i) => {
      const child = byId.get(id);
      return child ? build(child, i) : [];
    });
    if (DROP_ROLES.has(role)) return [];

    const name = clean(n.name?.value);
    const value = clean(n.value?.value);
    const ref = n.backendDOMNodeId !== undefined ? `e${n.backendDOMNodeId}` : `a${str(n.nodeId) || index}`;
    const node: SnapshotNode = { ref, role, name, ...(value ? { value } : {}) };

    if (TEXT_ROLES.has(role)) return name ? [{ node, children: [] }] : [];
    // The document itself is the frame everything is in; its children start at the top.
    if (role === 'RootWebArea' && !n.parentId) return kids;
    // An ignored node is not a node to a reader at all.
    if (n.ignored || !role) return kids;

    const container = !name && !value && !INTERACTIVE_ROLES.has(role) && !SEMANTIC_ROLES.has(role);
    if (container) {
      if (kids.length <= 1) return kids;
      return [{ node, children: kids }];
    }
    const only = kids.length === 1 ? kids[0] : undefined;
    if (only && only.children.length === 0 && TEXT_ROLES.has(only.node.role) && only.node.name === name) {
      return [{ node, children: [] }];
    }
    return [{ node, children: kids }];
  };

  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const forest = roots.flatMap((n, i) => build(n, i));

  const out: SnapshotNode[] = [];
  const refs = new Set<string>();
  const walk = (list: Built[], depth: number): void => {
    for (const b of list) {
      if (out.length >= limit) return;
      if (!refs.has(b.node.ref)) {
        refs.add(b.node.ref);
        out.push({ ...b.node, depth });
      }
      walk(b.children, depth + 1);
    }
  };
  walk(forest, 0);
  return out;
}

/** The DOM node a ref points at, or null when the ref is not clickable. */
export function backendNodeIdOf(ref: string): number | null {
  const m = /^e(\d+)$/.exec(ref);
  return m?.[1] ? Number(m[1]) : null;
}

export interface GotoResult {
  url: string;
  /** False when the load timed out; the page is still usable, just not finished. */
  loaded: boolean;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  /** 0-100. Ignored for png. */
  quality?: number;
  format?: 'png' | 'jpeg';
}

/**
 * Keys we can name. Chromium wants a virtual key code as well as a name, and
 * getting that wrong is a silent no-op rather than an error, so the table is
 * explicit instead of computed.
 */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

export function keyDescriptor(name: string): { key: string; code: string; keyCode: number; text?: string } {
  const hit = KEYS[name] ?? KEYS[name.charAt(0).toUpperCase() + name.slice(1)];
  if (hit) return hit;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: name };
  }
  throw new HuskError('E_TOOL_ERROR', `unknown key ${name}`, {
    hint: `named keys are: ${Object.keys(KEYS).join(', ')}, or any single character`,
  });
}

/**
 * One tab, addressed by its target id.
 *
 * There is deliberately no session id here. A CDP session belongs to a
 * websocket: a served driver keeps one per tab for as long as it runs, a
 * one-shot driver attaches afresh on every call, and a target id outlives
 * both. So the domain enables a fresh session needs are replayed as a prelude
 * on every call, whichever kind answers. Three extra commands on a loopback
 * socket cost well under a millisecond; getting this wrong costs a protocol
 * error on every second call.
 *
 * Each public method is one driver invocation wherever the CDP sequence allows
 * it, and two where husk has to do arithmetic in the middle -- a click needs
 * the box model back before it knows where to click.
 */
export class Page {
  /** Domains a fresh session needs. Replayed on every invocation, because the session is. */
  private readonly prelude: SendStep[] = [
    { op: 'send', method: 'Page.enable', session: true },
    { op: 'send', method: 'Runtime.enable', session: true },
    { op: 'send', method: 'DOM.enable', session: true },
  ];

  /** Emulation is per-session too, so an override has to be re-applied, not just set once. */
  private viewport: { width: number; height: number } | undefined;

  constructor(
    private readonly conn: CdpConnection,
    readonly targetId: string,
  ) {}

  private preludeSteps(): SendStep[] {
    if (!this.viewport) return this.prelude;
    return [
      ...this.prelude,
      {
        op: 'send',
        method: 'Emulation.setDeviceMetricsOverride',
        params: { ...this.viewport, deviceScaleFactor: 1, mobile: false },
        session: true,
      },
    ];
  }

  /** Run a batch against this page, and hand back only the caller's results. */
  private async run(steps: DriverStep[], timeoutMs?: number): Promise<unknown[]> {
    const prefix = this.preludeSteps();
    const all = await this.conn.run([...prefix, ...steps], {
      targetId: this.targetId,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return all.slice(prefix.length);
  }

  private async send(method: string, params: CdpParams = {}, opts: { soft?: boolean } = {}): Promise<CdpParams> {
    const [only] = await this.run([{ op: 'send', method, params, session: true, ...opts }]);
    return (only ?? {}) as CdpParams;
  }

  /** Attach once up front, so a broken target fails at open rather than at the first click. */
  /** The target this page drives, so a session can compare tabs by identity. */
  get id(): string {
    return this.targetId;
  }

  async init(): Promise<void> {
    await this.run([]);
  }

  /**
   * Navigate.
   *
   * The caller is responsible for the policy check -- `session.ts` does it,
   * because only it knows which provider owns this loopback.
   *
   * Navigate, wait, and read the URL back are one invocation on purpose. Split
   * across three, the load event would fire into a driver that had already
   * exited. `skipIf` is what keeps a refused navigation from then sitting out
   * the full load timeout before reporting the refusal.
   */
  async goto(url: string, opts: { timeoutMs?: number } = {}): Promise<GotoResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const [nav, load, href] = await this.run(
      [
        { op: 'send', method: 'Page.navigate', params: { url }, session: true },
        {
          op: 'wait',
          event: 'Page.loadEventFired',
          session: true,
          timeoutMs,
          optional: true,
          skipIf: { step: 0, key: 'errorText' },
        },
        {
          op: 'send',
          method: 'Runtime.evaluate',
          params: evalParams('location.href'),
          session: true,
          skipIf: { step: 0, key: 'errorText' },
        },
      ],
      timeoutMs + 30_000,
    );

    const errorText = ((nav ?? {}) as CdpParams)['errorText'];
    if (typeof errorText === 'string' && errorText) {
      throw new HuskError('E_EXEC_FAILED', `could not load ${url}: ${errorText}`, {
        hint: 'the browser reached the network stack and was refused -- check the host and the scheme',
        details: { url, errorText },
      });
    }

    const settled = valueOf((href ?? {}) as CdpParams);
    return { url: typeof settled === 'string' ? settled : url, loaded: waitResultOf(load).fired };
  }

  /**
   * Wait for the next load event.
   *
   * "Next" is literal: a driver only hears events emitted while it is
   * connected, so a load that already finished is not sitting somewhere waiting
   * to be collected. This is for the navigation an action has just started.
   */
  /**
   * Wait for a load only if the click actually started one.
   *
   * Most clicks navigate nothing -- they open a menu, tick a box, run some
   * JavaScript. `Page.loadEventFired` never arrives for those, so waiting on it
   * unconditionally spent the full timeout on the common case and made every
   * interaction feel broken. Watch for navigation *starting* in a short window
   * instead, and only then wait for it to finish.
   */
  /** `click`, named for what a caller cares about: did the page move. */
  async clickAndSettle(ref: string, loadTimeoutMs = 5000): Promise<{ navigated: boolean }> {
    const { navigationStarted } = await this.click(ref, loadTimeoutMs);
    return { navigated: navigationStarted };
  }

  async waitForLoad(timeoutMs = 30_000): Promise<boolean> {
    const [load] = await this.run(
      [{ op: 'wait', event: 'Page.loadEventFired', session: true, timeoutMs, optional: true }],
      timeoutMs + 30_000,
    );
    return waitResultOf(load).fired;
  }

  async url(): Promise<string> {
    const res = await this.evaluate('location.href');
    return typeof res === 'string' ? res : '';
  }

  async title(): Promise<string> {
    const res = await this.evaluate('document.title');
    return typeof res === 'string' ? res : '';
  }

  async content(): Promise<string> {
    const res = await this.evaluate('document.documentElement.outerHTML');
    return typeof res === 'string' ? res : '';
  }

  /** The rendered text, which is the thing a JS-only page has and a fetch does not. */
  async text(maxChars = 120_000): Promise<string> {
    const res = await this.evaluate(
      `(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${maxChars})`,
    );
    return typeof res === 'string' ? res : '';
  }

  async evaluate(expression: string): Promise<unknown> {
    const res = await this.send('Runtime.evaluate', evalParams(expression));
    assertNoPageException(res);
    return valueOf(res);
  }

  /**
   * Everything on this page a caller can read or act on.
   *
   * The tree comes from the page's own session, which covers same-origin
   * iframes and does *not* cover cross-origin ones -- those render in their own
   * process and appear here as a single empty `Iframe` node. That matters more
   * than it sounds: consent dialogs, card fields and embedded sign-in are
   * routinely cross-origin, so the most important element on the page can be
   * the one thing missing from the list.
   *
   * It cannot be fixed by asking harder; it needs attaching to the child
   * target, which is a different connection. Until that exists, the gap is
   * *reported* rather than left as a silence a model would read as "the page
   * does not have one".
   */
  async snapshot(opts: { limit?: number } = {}): Promise<SnapshotNode[]> {
    const [, tree, frames] = await this.run([
      { op: 'send', method: 'Accessibility.enable', session: true },
      { op: 'send', method: 'Accessibility.getFullAXTree', session: true },
      {
        op: 'send',
        method: 'Runtime.evaluate',
        params: evalParams(unreachableFramesExpression()),
        session: true,
        soft: true,
      },
    ]);

    const res = (tree ?? {}) as CdpParams;
    const nodes = Array.isArray(res['nodes']) ? (res['nodes'] as AxNodeLike[]) : [];
    const unreachable = ((frames ?? {}) as { result?: { value?: unknown } }).result?.value;
    return snapshotOf(nodes, unreachable, opts);
  }

  /**
   * Several page actions in one driver round, stopping at the first that fails.
   *
   * Code over calls, ego-lite's idea (MIT, Copyright (c) 2026 CitroLabs): the
   * cost of a browser tool is mostly the round trip, so a model that knows its
   * next five steps should pay for one. The actions are data and the driver
   * runs them; the only page script involved is what this file builds from
   * JSON-quoted arguments. Gotos must already be policy-checked -- `session.ts`
   * does it, as it does for `goto`.
   */
  /**
   * Run a Python script against this page, in its own process inside the
   * computer, killed at `limitSec`. It reaches the page only through `page.*`,
   * which the driver answers with the same actions `browser_run` uses, and
   * whose gotos the session checks against the network policy (see
   * `BrowserSession.script`). Needs the long-lived driver.
   */
  async script(source: string, limitSec: number): Promise<ScriptOutcome> {
    const limitMs = limitSec * 1000;
    const [raw] = await this.run(
      [{ op: 'action', session: true, do: 'script', source, limitSec, timeoutMs: limitMs }],
      limitMs + 45_000,
    );
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      output: typeof r['output'] === 'string' ? r['output'] : '',
      truncated: r['truncated'] === true,
      result: r['result'] ?? null,
      ms: typeof r['ms'] === 'number' ? r['ms'] : 0,
      ...(typeof r['error'] === 'string' ? { error: r['error'] } : {}),
    };
  }

  async actions(list: PageAction[]): Promise<ActionOutcome[]> {
    let budget = 10_000;
    const steps: DriverStep[] = list.map((a) => {
      const step = actionStep(a);
      budget += step.timeoutMs ?? 30_000;
      return step;
    });
    const results = await this.run(steps, budget);
    return list.map((a, i) => outcomeOf(a, results[i]));
  }

  /** Base64 png (or jpeg). `fullPage` captures past the viewport. */
  async screenshot(opts: ScreenshotOptions = {}): Promise<string> {
    const format = opts.format ?? 'png';
    const params: CdpParams = { format, captureBeyondViewport: opts.fullPage === true };
    if (format === 'jpeg') params['quality'] = opts.quality ?? 80;

    if (opts.fullPage) {
      // The clip depends on the metrics, so this one genuinely needs two trips.
      const metrics = await this.send('Page.getLayoutMetrics');
      const content = (metrics['cssContentSize'] ?? metrics['contentSize']) as
        | { width?: number; height?: number }
        | undefined;
      if (content?.width && content.height) {
        params['clip'] = { x: 0, y: 0, width: content.width, height: content.height, scale: 1 };
      }
    }

    const res = await this.send('Page.captureScreenshot', params);
    const data = res['data'];
    if (typeof data !== 'string') {
      throw new HuskError('E_EXEC_FAILED', 'Chromium returned no screenshot data', {
        hint: 'this is a husk bug; the raw result is in details',
        details: { result: res },
      });
    }
    return data;
  }

  /**
   * One frame for a person watching: a JPEG of the viewport, and the viewport's
   * size in CSS pixels so a click on the image can be mapped back whatever the
   * device scale. One driver invocation.
   */
  async frame(quality = 70): Promise<{ data: string; width: number; height: number }> {
    const [metrics, shot] = await this.run([
      { op: 'send', method: 'Page.getLayoutMetrics', params: {}, session: true },
      { op: 'send', method: 'Page.captureScreenshot', params: { format: 'jpeg', quality }, session: true },
    ]);
    const vp = ((metrics ?? {}) as CdpParams)['cssLayoutViewport'] as
      | { clientWidth?: number; clientHeight?: number }
      | undefined;
    const data = ((shot ?? {}) as CdpParams)['data'];
    if (typeof data !== 'string' || !vp?.clientWidth || !vp.clientHeight) {
      throw new HuskError('E_EXEC_FAILED', 'Chromium returned no frame', {
        hint: 'the page may be mid-navigation; try again',
      });
    }
    return { data, width: vp.clientWidth, height: vp.clientHeight };
  }

  /**
   * Input from a person, at viewport coordinates.
   *
   * Only `Input.*` commands: a person gets a mouse and a keyboard, not script.
   * Nothing here can evaluate in the page or read the profile.
   */
  async clickAt(x: number, y: number, opts: { button?: 'left' | 'right'; clickCount?: 1 | 2 } = {}): Promise<void> {
    const button = opts.button ?? 'left';
    const base = { x, y, button, clickCount: opts.clickCount ?? 1 };
    await this.run([
      { op: 'send', method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, session: true },
      { op: 'send', method: 'Input.dispatchMouseEvent', params: { ...base, type: 'mousePressed', buttons: button === 'left' ? 1 : 2 }, session: true },
      { op: 'send', method: 'Input.dispatchMouseEvent', params: { ...base, type: 'mouseReleased', buttons: 0 }, session: true },
    ]);
  }

  async wheelAt(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.run([
      { op: 'send', method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX, deltaY }, session: true },
    ]);
  }

  /** Text into whatever has focus. An input event, not an evaluate. */
  async insertText(text: string): Promise<void> {
    await this.run([{ op: 'send', method: 'Input.insertText', params: { text }, session: true }]);
  }

  private async centreOf(ref: string): Promise<{ x: number; y: number; backendNodeId: number }> {
    const backendNodeId = backendNodeIdOf(ref);
    if (backendNodeId === null) {
      throw new HuskError('E_TOOL_ERROR', `${ref} is not a clickable element`, {
        hint: 'refs beginning with `a` are informational nodes with no DOM element; take a fresh snapshot',
      });
    }

    // Both soft: a detached or display:none node cannot be scrolled to, and the
    // box model gives the better error, so the scroll failing on its own is not
    // worth surfacing.
    const [, box] = await this.run([
      { op: 'send', method: 'DOM.scrollIntoViewIfNeeded', params: { backendNodeId }, session: true, soft: true },
      { op: 'send', method: 'DOM.getBoxModel', params: { backendNodeId }, session: true, soft: true },
    ]);

    const model = ((box ?? {}) as CdpParams)['model'] as { content?: number[] } | undefined;
    const quad = model?.content;
    if (!quad || quad.length < 8) {
      throw new HuskError('E_TOOL_ERROR', `${ref} is no longer on the page`, {
        hint: 'the page changed since the snapshot -- call browser_snapshot again and use the new ref',
        details: { ref },
      });
    }

    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    return {
      backendNodeId,
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }

  /**
   * Click, and report whether that started a navigation.
   *
   * The watch is part of the *same* driver invocation as the click, not a call
   * after it. The driver buffers events as they arrive and `wait` checks that
   * buffer first, so a navigation that completes before the listener would
   * otherwise have attached is still seen. Watching from a second invocation
   * loses exactly the fast local navigations this is for -- measured: the URL
   * had already changed and the watcher reported nothing.
   */
  async click(ref: string, loadTimeoutMs = 5000): Promise<{ navigationStarted: boolean }> {
    const { x, y } = await this.centreOf(ref);
    const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
    const results = await this.run([
      { op: 'send', method: 'Input.dispatchMouseEvent', params: { ...base, type: 'mousePressed' }, session: true },
      {
        op: 'send',
        method: 'Input.dispatchMouseEvent',
        params: { ...base, type: 'mouseReleased', buttons: 0 },
        session: true,
      },
      { op: 'wait', event: 'Page.frameStartedLoading', session: true, timeoutMs: 250, optional: true },
      // Same batch, and skipped entirely when nothing navigated. It has to be
      // here rather than in a follow-up call: each driver invocation is a fresh
      // process on a fresh connection, so a load event that fired during the
      // click is simply gone by the time a second invocation starts listening.
      {
        op: 'wait',
        event: 'Page.loadEventFired',
        session: true,
        timeoutMs: loadTimeoutMs,
        optional: true,
        skipUnless: { step: 2, key: 'fired' },
      },
    ]);
    return { navigationStarted: waitResultOf(results[2]).fired };
  }

  async type(ref: string, text: string, opts: { clear?: boolean } = {}): Promise<void> {
    const { backendNodeId } = await this.centreOf(ref);
    const steps: DriverStep[] = [{ op: 'send', method: 'DOM.focus', params: { backendNodeId }, session: true }];

    if (opts.clear !== false) {
      // Selecting first means `type` replaces rather than appends, which is what
      // "type this into the search box" means every single time.
      steps.push({
        op: 'send',
        method: 'Runtime.evaluate',
        params: evalParams(`(() => { const el = document.activeElement; if (el && 'select' in el) el.select(); })()`),
        session: true,
      });
    }

    steps.push({ op: 'send', method: 'Input.insertText', params: { text }, session: true });
    // insertText does not fire key events; frameworks listening for `input` are
    // satisfied by it, but ones listening for change need the nudge.
    steps.push({
      op: 'send',
      method: 'Runtime.evaluate',
      params: evalParams(
        `(() => { const el = document.activeElement; if (el) el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      ),
      session: true,
    });

    for (const result of await this.run(steps)) {
      assertNoPageException((result ?? {}) as CdpParams);
    }
  }

  async press(key: string): Promise<void> {
    const d = keyDescriptor(key);
    const common = { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
    await this.run([
      {
        op: 'send',
        method: 'Input.dispatchKeyEvent',
        params: { ...common, type: d.text ? 'keyDown' : 'rawKeyDown', ...(d.text ? { text: d.text } : {}) },
        session: true,
      },
      { op: 'send', method: 'Input.dispatchKeyEvent', params: { ...common, type: 'keyUp' }, session: true },
    ]);
  }

  /**
   * Wait for something to appear, rather than for a navigation.
   *
   * `waitForLoad` answers "did the page navigate", which on a single-page app is
   * almost always "no" -- the content arrives and the load event never fires
   * again. That made every SPA a guessing game: snapshot, find nothing, snapshot
   * again. This waits for the thing actually being waited on.
   *
   * Polling rather than a MutationObserver on purpose: each driver invocation is
   * its own process and connection, so an observer registered in one call is
   * gone by the next. The loop runs inside a single `Runtime.evaluate`, so it is
   * one round trip however long it waits.
   */
  async waitFor(
    what: { text?: string; selector?: string; gone?: boolean },
    timeoutMs = 15_000,
  ): Promise<{ found: boolean; waitedMs: number }> {
    const started = Date.now();
    const [result] = await this.run([
      {
        op: 'send',
        method: 'Runtime.evaluate',
        params: evalParams(waitExpression(what, timeoutMs)),
        session: true,
        // The page's own clock decides; the transport only has to outlast it.
        timeoutMs: timeoutMs + 5000,
      },
    ]);

    assertNoPageException((result ?? {}) as CdpParams);
    const value = ((result ?? {}) as { result?: { value?: unknown } }).result?.value;
    return { found: value === true, waitedMs: Date.now() - started };
  }

  /**
   * Scroll the window, or bring an element into view.
   *
   * Without this, anything below the fold is unreachable in practice: the
   * accessibility tree carries the whole document, so a model can *see* a button
   * it cannot click, and an infinite-scroll page never loads its next page.
   */
  async scroll(opts: { ref?: string; by?: number; to?: 'top' | 'bottom' } = {}): Promise<void> {
    if (opts.ref) {
      // `centreOf` already scrolls into view; this is the same operation, named
      // for what a caller wants when they are not about to click.
      await this.centreOf(opts.ref);
      return;
    }

    const how =
      opts.to === 'top'
        ? 'window.scrollTo(0, 0)'
        : opts.to === 'bottom'
          ? 'window.scrollTo(0, document.body.scrollHeight)'
          : `window.scrollBy(0, ${Number(opts.by ?? 600)})`;

    const [result] = await this.run([
      { op: 'send', method: 'Runtime.evaluate', params: evalParams(`(() => { ${how}; })()`), session: true },
    ]);
    assertNoPageException((result ?? {}) as CdpParams);
  }

  /**
   * Choose an option in a native `<select>`.
   *
   * Clicking one headless does not open a menu that can then be clicked -- the
   * popup is drawn by the platform, not the page -- so `click` on a dropdown
   * appears to succeed and changes nothing. Setting the value and firing the
   * events a framework listens for is the only thing that does.
   */
  async select(ref: string, value: string): Promise<{ selected: string }> {
    const { backendNodeId } = await this.centreOf(ref);
    const [, result] = await this.run([
      { op: 'send', method: 'DOM.focus', params: { backendNodeId }, session: true },
      {
        op: 'send',
        method: 'Runtime.evaluate',
        params: evalParams(selectExpression(value)),
        session: true,
      },
    ]);

    assertNoPageException((result ?? {}) as CdpParams);
    const chosen = ((result ?? {}) as { result?: { value?: unknown } }).result?.value;
    return { selected: String(chosen ?? '') };
  }

  /**
   * Attach files to a file input.
   *
   * The paths are inside the computer, which is the only place they could be:
   * the browser is in there too, and the host filesystem is a different machine
   * as far as this page is concerned.
   */
  async setFiles(ref: string, files: string[]): Promise<void> {
    const backendNodeId = backendNodeIdOf(ref);
    if (backendNodeId === null) {
      throw new HuskError('E_TOOL_ERROR', `${ref} is not an element`, {
        hint: 'take a fresh snapshot and use the ref of the file input',
      });
    }
    const [result] = await this.run([
      { op: 'send', method: 'DOM.setFileInputFiles', params: { backendNodeId, files }, session: true },
    ]);
    assertNoPageException((result ?? {}) as CdpParams);
  }

  /** Hover, for the menus that only exist under the pointer. */
  async hover(ref: string): Promise<void> {
    const { x, y } = await this.centreOf(ref);
    await this.run([
      {
        op: 'send',
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0 },
        session: true,
      },
    ]);
  }

  /** Back, forward or reload, waiting for whatever it starts. */
  async navigate(how: 'back' | 'forward' | 'reload', timeoutMs = 15_000): Promise<{ url: string }> {
    if (how === 'reload') {
      await this.run([
        { op: 'send', method: 'Page.reload', params: {}, session: true },
        { op: 'wait', event: 'Page.loadEventFired', session: true, timeoutMs, optional: true },
      ]);
      return { url: await this.url() };
    }

    // History is read first because CDP addresses entries by id rather than by
    // offset, and stepping past either end is an error, not a no-op.
    const [history] = await this.run([
      { op: 'send', method: 'Page.getNavigationHistory', params: {}, session: true },
    ]);
    const h = (history ?? {}) as { currentIndex?: number; entries?: Array<{ id?: number }> };
    const index = (h.currentIndex ?? 0) + (how === 'back' ? -1 : 1);
    const entry = h.entries?.[index];
    if (!entry || entry.id === undefined) {
      throw new HuskError('E_TOOL_ERROR', `there is no page to go ${how} to`, {
        hint: how === 'back' ? 'this is the first page in this tab' : 'nothing has been navigated back from',
      });
    }

    await this.run([
      { op: 'send', method: 'Page.navigateToHistoryEntry', params: { entryId: entry.id }, session: true },
      { op: 'wait', event: 'Page.loadEventFired', session: true, timeoutMs, optional: true },
    ]);
    return { url: await this.url() };
  }

  async setViewport(width: number, height: number): Promise<void> {
    this.viewport = { width, height };
    // The prelude applies it from here on; this call makes it true right now.
    await this.run([]);
  }

  async close(): Promise<void> {
    // Browser-level, and soft: closing an already-closed tab is not an error
    // worth propagating.
    await this.conn
      .run([{ op: 'send', method: 'Target.closeTarget', params: { targetId: this.targetId }, soft: true }])
      .catch(() => undefined);
  }
}

/**
 * The page-side wait loop: true once the text, URL or selector is there (or
 * gone), false at the deadline. Polling rather than a MutationObserver, so a
 * one-shot driver -- a process per call -- waits the same way a served one does.
 */
export function waitExpression(what: { text?: string; url?: string; selector?: string; gone?: boolean }, timeoutMs: number): string {
  const probe = what.selector
    ? `!!document.querySelector(${JSON.stringify(what.selector)})`
    : what.url !== undefined
      ? `location.href.includes(${JSON.stringify(what.url)})`
      : `document.body ? document.body.innerText.includes(${JSON.stringify(what.text ?? '')}) : false`;
  const want = what.gone === true ? 'false' : 'true';
  return `(async () => {
     const deadline = Date.now() + ${Math.max(0, timeoutMs)};
     while (Date.now() < deadline) {
       if ((${probe}) === ${want}) return true;
       await new Promise((r) => setTimeout(r, 100));
     }
     return (${probe}) === ${want};
   })()`;
}

/** Which element an action means: a ref from a snapshot, or a role and its accessible name. */
export interface ElementTarget {
  ref?: string;
  role?: string;
  name?: string;
}

/** One step of `browser_run`. Data only: the driver does it, nothing evaluates it. */
export type PageAction =
  | { do: 'goto'; url: string; timeoutMs?: number }
  | ({ do: 'click' } & ElementTarget)
  | ({ do: 'fill'; text: string; submit?: boolean } & ElementTarget)
  | { do: 'wait'; text?: string; url?: string; selector?: string; gone?: boolean; timeoutMs?: number }
  | { do: 'snapshot'; limit?: number }
  | { do: 'screenshot'; fullPage?: boolean };

/** What a script printed and left in `result`, or the traceback it died with. */
export interface ScriptOutcome {
  output: string;
  /** Output past 64 KB was dropped. */
  truncated: boolean;
  result: unknown;
  ms: number;
  error?: string;
}

/** What one action did. `skipped` follows an earlier failure; `error` is that failure. */
export interface ActionOutcome {
  do: PageAction['do'];
  ok: boolean;
  skipped?: boolean;
  error?: string;
  url?: string;
  loaded?: boolean;
  ref?: string;
  navigated?: boolean;
  waitedMs?: number;
  nodes?: SnapshotNode[];
  /** Base64 PNG, for `screenshot`. */
  data?: string;
}

function actionStep(a: PageAction): DriverStep {
  const base = { op: 'action' as const, session: true };
  switch (a.do) {
    case 'goto': {
      const load = a.timeoutMs ?? 30_000;
      return { ...base, do: 'goto', url: a.url, loadTimeoutMs: load, timeoutMs: load + 30_000 };
    }
    case 'click':
      return { ...base, do: 'click', ...target(a), timeoutMs: 30_000 };
    case 'fill':
      return { ...base, do: 'fill', ...target(a), text: a.text, ...(a.submit ? { submit: true } : {}), timeoutMs: 30_000 };
    case 'wait': {
      const wait = a.timeoutMs ?? 15_000;
      const what = a.selector !== undefined ? `selector ${a.selector}` : a.url !== undefined ? `url ${JSON.stringify(a.url)}` : `text ${JSON.stringify(a.text ?? '')}`;
      return {
        ...base,
        do: 'wait',
        expression: waitExpression(a, wait),
        what,
        ...(a.gone ? { gone: true } : {}),
        // The page's own clock decides; the driver only has to outlast it.
        timeoutMs: wait + 5000,
      };
    }
    case 'snapshot':
      return { ...base, do: 'snapshot', framesExpression: unreachableFramesExpression(), timeoutMs: 30_000 };
    case 'screenshot':
      return { ...base, do: 'screenshot', ...(a.fullPage ? { fullPage: true } : {}), timeoutMs: 60_000 };
  }
}

function target(a: ElementTarget): ElementTarget {
  return {
    ...(a.ref !== undefined ? { ref: a.ref } : {}),
    ...(a.role !== undefined ? { role: a.role } : {}),
    ...(a.name !== undefined ? { name: a.name } : {}),
  };
}

function outcomeOf(a: PageAction, raw: unknown): ActionOutcome {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r['skipped'] === true) return { do: a.do, ok: false, skipped: true };
  if (typeof r['error'] === 'string') return { do: a.do, ok: false, error: r['error'] };
  const out: ActionOutcome = { do: a.do, ok: true };
  if (typeof r['url'] === 'string') out.url = r['url'];
  if (typeof r['loaded'] === 'boolean') out.loaded = r['loaded'];
  if (typeof r['ref'] === 'string') out.ref = r['ref'];
  if (typeof r['navigated'] === 'boolean') out.navigated = r['navigated'];
  if (typeof r['waitedMs'] === 'number') out.waitedMs = r['waitedMs'];
  if (typeof r['data'] === 'string') out.data = r['data'];
  if (a.do === 'snapshot') {
    const nodes = Array.isArray(r['nodes']) ? (r['nodes'] as AxNodeLike[]) : [];
    out.nodes = snapshotOf(nodes, r['unreachable'], a.limit !== undefined ? { limit: a.limit } : {});
  }
  return out;
}

/** The compact tree, plus a line saying which frames it could not see into. */
function snapshotOf(nodes: AxNodeLike[], unreachable: unknown, opts: { limit?: number }): SnapshotNode[] {
  const tree = compactAxTree(nodes, opts);
  if (Array.isArray(unreachable) && unreachable.length > 0) {
    tree.push({
      ref: 'x0',
      role: 'UnreachableFrames',
      name:
        `${unreachable.length} cross-origin iframe${unreachable.length === 1 ? '' : 's'} on this page ` +
        `cannot be read or clicked from here: ${unreachable.map(String).join(', ')}`,
      depth: 0,
    });
  }
  return tree;
}

/** The one shape every `Runtime.evaluate` in this file uses. */
function evalParams(expression: string): CdpParams {
  return {
    expression,
    returnByValue: true,
    awaitPromise: true,
    // Clicking is a user gesture as far as the page is concerned; so is this,
    // otherwise anything gated on one (fullscreen, clipboard) silently fails.
    userGesture: true,
  };
}

function assertNoPageException(res: CdpParams): void {
  const details = res['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
  if (!details) return;
  throw new HuskError(
    'E_TOOL_ERROR',
    `the page threw: ${details.exception?.description ?? details.text ?? 'unknown error'}`,
    { hint: 'the expression ran in the page, so this is the page’s error, not husk’s' },
  );
}

function valueOf(res: CdpParams | undefined): unknown {
  const result = (res ?? {})['result'] as { value?: unknown } | undefined;
  return result?.value;
}

/**
 * The page-side half of `select`, as a string.
 *
 * Extracted so it can be run against a real DOM in a test. Everything here
 * executes inside the page, where there is no husk, no types and no way to see
 * a failure except the exception text -- so the message on the way out has to
 * carry the options, or a model that guessed wrong has nothing to guess from.
 */
export function selectExpression(value: string): string {
  return `(() => {
     const el = document.activeElement;
     if (!el || el.tagName !== 'SELECT') throw new Error('that ref is not a <select>');
     const want = ${JSON.stringify(value)};
     const match = [...el.options].find((o) => o.value === want)
       || [...el.options].find((o) => o.text.trim() === want.trim());
     if (!match) {
       throw new Error('no option matching ' + JSON.stringify(want) +
         '; options are ' + JSON.stringify([...el.options].map((o) => o.text.trim())));
     }
     el.value = match.value;
     el.dispatchEvent(new Event('input', { bubbles: true }));
     el.dispatchEvent(new Event('change', { bubbles: true }));
     return match.text.trim();
   })()`;
}

/**
 * The page-side half of the cross-origin iframe report.
 *
 * `contentDocument` is null for a frame the document may not read, and reading
 * it can itself throw in some engines, so both are treated as "cannot see in".
 * A same-origin frame is readable and is deliberately not reported: it is
 * already in the accessibility tree, and naming it would train a reader to
 * ignore the warning.
 */
export function unreachableFramesExpression(limit = 10): string {
  return `(() => [...document.querySelectorAll('iframe')]
     .filter((f) => { try { return !f.contentDocument; } catch { return true; } })
     .map((f) => {
       // The src property resolves against the document, so an iframe with
       // no src reports the page's own URL -- which reads as a frame that is
       // somewhere it is not. The attribute says whether there is one at all.
       const raw = f.getAttribute('src');
       return raw && raw.trim() ? f.src : '(no src)';
     })
     .slice(0, ${limit}))()`;
}
