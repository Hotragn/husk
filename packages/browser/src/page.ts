import { HuskError } from '@husk-ai/core';
import { waitResultOf } from './cdp.js';
import { DOWNLOADS_DIR } from './provision.js';
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
  /** The frame a node is in, `f<k>`, for a node of a frame the driver spliced in under its <iframe>. */
  frame?: string;
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
      node.backendDOMNodeId !== undefined ? `${node.frame ?? ''}e${node.backendDOMNodeId}` : `a${str(node.nodeId) || out.length}`;
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
 * The rules come from a third-party snapshot spec (see THIRD_PARTY_NOTICES.md):
 * drop text that is
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
    const ref = n.backendDOMNodeId !== undefined ? `${n.frame ?? ''}e${n.backendDOMNodeId}` : `a${str(n.nodeId) || index}`;
    const node: SnapshotNode = { ref, role, name, ...(value ? { value } : {}) };

    if (TEXT_ROLES.has(role)) return name ? [{ node, children: [] }] : [];
    // The document itself is the frame everything is in; its children start at the top.
    // A frame's document too: its <iframe>'s line already says where the frame starts.
    if (role === 'RootWebArea') return kids;
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

/**
 * The DOM node a ref points at, or null when the ref is not clickable. A
 * frame's ref, `f<k>e<n>`, names node n of frame k: a frame in another process
 * numbers its nodes afresh, so the id alone does not say which node.
 */
export function backendNodeIdOf(ref: string): number | null {
  const m = /^(?:f\d+)?e(\d+)$/.exec(ref);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * What a page did during an action besides its own result: the dialogs it
 * showed and how Husk answered them, the files it downloaded (into
 * DOWNLOADS_DIR), and the tabs it opened.
 */
export interface Happened {
  dialogs?: Array<{ type: string; message: string; answer: string }>;
  downloads?: Array<{ name: string; state: string; bytes?: number }>;
  popups?: Array<{ targetId: string; url: string }>;
  /** Document loads the network policy stopped: a redirect's next hop, a link, a frame, a pop-up. */
  blocked?: Array<{ url: string; reason: string }>;
}

export interface GotoResult extends Happened {
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
  /** Which document, and which frame, each ref a snapshot here handed out came from: it acts only there. */
  private readonly refDocuments = new Map<string, { document: string; frame?: string }>();
  /** Each frame's number, by frame id, so a frame keeps its `f<k>` for as long as this page is open. */
  private readonly frameKeys = new Map<string, number>();

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
    // The driver's goto: a dialog the page shows on load is answered and said,
    // and a URL that is a file to download is a download, not a failure.
    const [out] = await this.actions([{ do: 'goto', url, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) }]);
    if (!out?.ok && out?.blocked?.length) {
      // Husk checked this URL; a redirect from it went where the policy refuses, and the driver stopped it.
      throw new HuskError('E_EXEC_DENIED', out.error ?? `the network policy refused where ${url} led`, {
        hint: 'nothing was sent there; name the host in computer.network.allow if this page should reach it',
        details: { url, blocked: out.blocked },
      });
    }
    if (!out?.ok) {
      throw new HuskError('E_EXEC_FAILED', out?.error ?? `could not load ${url}`, {
        hint: 'the browser reached the network stack and was refused -- check the host and the scheme',
        details: { url },
      });
    }
    return { url: out.url ?? url, loaded: out.loaded === true, ...happenedOf(out) };
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
  /** `click`, named for what a caller cares about: did the page move, and what else it did. */
  async clickAndSettle(ref: string, loadTimeoutMs = 5000, opts: ClickOptions = {}): Promise<{ navigated: boolean } & Happened> {
    const { navigationStarted, ...rest } = await this.click(ref, loadTimeoutMs, opts);
    return { navigated: navigationStarted, ...rest };
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
   * Everything on this page a caller can read or act on, frames included.
   *
   * The page's own tree has each iframe as an empty `Iframe` node, so the
   * driver reads every frame and puts its tree under that node: a same-site
   * frame from the page's session, a cross-site one from its own, since
   * Chromium runs it in another process. That matters more than it sounds:
   * consent dialogs, card fields and embedded sign-in are routinely
   * cross-origin, so the most important element on the page can be in one.
   * A frame's refs are `f<k>e<n>`, and a frame that cannot be read is said,
   * not left as a silence a model would read as "the page does not have one".
   */
  async snapshot(opts: { limit?: number } = {}): Promise<SnapshotNode[]> {
    // The driver's snapshot action, which also records which document its refs belong to.
    const [out] = await this.actions([{ do: 'snapshot', ...(opts.limit !== undefined ? { limit: opts.limit } : {}) }]);
    if (!out?.ok) {
      throw new HuskError('E_EXEC_FAILED', out?.error ?? 'could not read the page', { hint: 'the page may be mid-navigation; try again' });
    }
    return out.nodes ?? [];
  }

  /**
   * Several page actions in one driver round, stopping at the first that fails.
   *
   * Code over calls (credited in THIRD_PARTY_NOTICES.md): the
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
      resultTruncated: r['resultTruncated'] === true,
      ms: typeof r['ms'] === 'number' ? r['ms'] : 0,
      ...(typeof r['error'] === 'string' ? { error: r['error'] } : {}),
      ...happenedOf(r as Happened),
    };
  }

  async actions(list: PageAction[]): Promise<ActionOutcome[]> {
    let budget = 10_000;
    const steps: DriverStep[] = list.map((a) => {
      const step = actionStep(a);
      budget += step.timeoutMs ?? 30_000;
      // For a driver that keeps nothing between requests: the frame numbers so far, and where a ref came from.
      if (a.do === 'snapshot') return this.frameKeys.size > 0 ? { ...step, frames: Object.fromEntries(this.frameKeys) } : step;
      const known = 'ref' in a && a.ref ? this.refDocuments.get(a.ref) : undefined;
      return known ? { ...step, document: known.document, ...(known.frame ? { frame: known.frame } : {}) } : step;
    });
    const results = await this.run(steps, budget);
    const outcomes = list.map((a, i) => outcomeOf(a, results[i]));
    for (const o of outcomes) if (o.nodes && o.document) this.remember(o.nodes, o.document, o.frames ?? {});
    return outcomes;
  }

  /** The refs a snapshot showed, as belonging to its document, or to their frame's. */
  private remember(nodes: SnapshotNode[], document: string, frames: Record<string, SnapshotFrame>): void {
    // ponytail: forgotten wholesale past a bound; a forgotten ref is checked by the driver, or not at all.
    if (this.refDocuments.size > 50_000) this.refDocuments.clear();
    if (this.frameKeys.size > 10_000) this.frameKeys.clear();
    for (const [key, f] of Object.entries(frames)) this.frameKeys.set(f.id, Number(key.slice(1)));
    for (const n of nodes) {
      if (backendNodeIdOf(n.ref) === null) continue;
      const key = /^(f\d+)e/.exec(n.ref)?.[1];
      const frame = key ? frames[key] : undefined;
      if (!key) this.refDocuments.set(n.ref, { document });
      else if (frame?.document) this.refDocuments.set(n.ref, { document: frame.document, frame: frame.id });
    }
  }

  /** One action on a ref, refused with the driver's reason. */
  private async act(a: PageAction & ElementTarget): Promise<ActionOutcome> {
    const [out] = await this.actions([a]);
    if (!out?.ok) {
      throw new HuskError('E_TOOL_ERROR', out?.error ?? `could not ${a.do} ${a.ref ?? 'that'}`, {
        hint: 'browser_snapshot shows the page as it is now',
        details: { ref: a.ref },
      });
    }
    return out;
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

  /**
   * Click, honestly, and report whether that started a navigation.
   *
   * The driver's `click` action: it refuses, saying why, an element that is
   * gone, disabled, hidden, still moving or covered by something the click
   * would land on instead; `force` skips the checks and presses at the
   * centre, as clicks always did. The navigation watch is in the same driver
   * round as the click, so a fast local navigation is not missed.
   */
  async click(ref: string, loadTimeoutMs = 5000, opts: ClickOptions = {}): Promise<{ navigationStarted: boolean } & Happened> {
    const [out] = await this.actions([
      { do: 'click', ref, loadTimeoutMs, ...(opts.force ? { force: true } : {}), ...(opts.dialog ? { dialog: opts.dialog } : {}) },
    ]);
    if (!out?.ok) {
      throw new HuskError('E_TOOL_ERROR', out?.error ?? `could not click ${ref}`, {
        hint: 'browser_snapshot shows the page as it is now',
        details: { ref },
      });
    }
    return { navigationStarted: out.navigated === true, ...happenedOf(out) };
  }

  /**
   * Type into the field with this ref: the driver's `fill`, which focuses the
   * field, selects what is there unless `clear` is false (so "type this into
   * the search box" replaces it), inserts the text and fires `change` -- all
   * on the field itself, never on `document.activeElement`, which inside a
   * frame is the frame.
   */
  async type(ref: string, text: string, opts: { clear?: boolean; submit?: boolean; dialog?: 'accept' | 'dismiss' } = {}): Promise<Happened> {
    const [out] = await this.actions([
      {
        do: 'fill',
        ref,
        text,
        ...(opts.clear === false ? { clear: false } : {}),
        ...(opts.submit ? { submit: true } : {}),
        ...(opts.dialog ? { dialog: opts.dialog } : {}),
      },
    ]);
    if (!out?.ok) {
      throw new HuskError('E_TOOL_ERROR', out?.error ?? `could not type into ${ref}`, {
        hint: 'browser_snapshot shows the page as it is now',
        details: { ref },
      });
    }
    return happenedOf(out);
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
      // The driver's `scroll`: the element into view, its frames' <iframe>s first.
      await this.act({ do: 'scroll', ref: opts.ref });
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
    // The driver's `select`, called on the <select> itself: the option is an argument, never script.
    const out = await this.act({ do: 'select', ref, value });
    return { selected: out.selected ?? '' };
  }

  /**
   * Attach files to a file input.
   *
   * The paths are inside the computer, which is the only place they could be:
   * the browser is in there too, and the host filesystem is a different machine
   * as far as this page is concerned.
   */
  async setFiles(ref: string, files: string[]): Promise<void> {
    await this.act({ do: 'upload', ref, files });
  }

  /** Hover, for the menus that only exist under the pointer. */
  async hover(ref: string): Promise<void> {
    await this.act({ do: 'hover', ref });
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

/** How a click goes: `force` skips its checks; `dialog` answers a confirm or prompt it opens (dismissed unless "accept"). */
export interface ClickOptions {
  force?: boolean;
  dialog?: 'accept' | 'dismiss';
}

/** The dialogs, downloads and tabs an outcome carries, and nothing else. */
export function happenedOf(o: Happened): Happened {
  return {
    ...(o.dialogs?.length ? { dialogs: o.dialogs } : {}),
    ...(o.downloads?.length ? { downloads: o.downloads } : {}),
    ...(o.popups?.length ? { popups: o.popups } : {}),
    ...(o.blocked?.length ? { blocked: o.blocked } : {}),
  };
}

/**
 * What else an action did, in words a model reads: a dialog Husk answered
 * (and how to answer it the other way), a file it downloaded, a tab it opened,
 * a load the network policy stopped.
 */
export function describeHappened(h: Happened): string[] {
  const lines: string[] = [];
  for (const d of h.dialogs ?? []) {
    const article = /^[aeiou]/.test(d.type) ? 'an' : 'a';
    lines.push(
      `The page showed ${article} ${d.type} dialog: ${JSON.stringify(d.message)}. Husk ${d.answer} it.` +
        (d.answer === 'dismissed' ? ' To accept it instead, do this again with dialog: "accept".' : ''),
    );
  }
  for (const f of h.downloads ?? []) {
    const where = `${DOWNLOADS_DIR}/${f.name}`;
    lines.push(
      f.state === 'completed'
        ? `It downloaded ${f.name}${f.bytes ? ` (${f.bytes} bytes)` : ''} to ${where}.`
        : `It started downloading ${f.name} to ${where}; the download is ${f.state}.`,
    );
  }
  for (const p of h.popups ?? []) lines.push(`It opened a new tab: ${p.url || 'about:blank'} (browser_tabs lists it, to switch to it).`);
  for (const b of h.blocked ?? []) lines.push(`The network policy stopped the page from loading ${b.url}: ${b.reason}.`);
  return lines;
}

/** Which element an action means: a ref from a snapshot, or a role and its accessible name. */
export interface ElementTarget {
  ref?: string;
  role?: string;
  name?: string;
}

/**
 * One step of `browser_run`, or one of Page's own (hover, scroll, upload),
 * which browser_run does not offer. Data only: the driver does it, nothing
 * evaluates it.
 */
export type PageAction =
  | { do: 'goto'; url: string; timeoutMs?: number }
  | ({ do: 'click'; force?: boolean; loadTimeoutMs?: number; dialog?: 'accept' | 'dismiss' } & ElementTarget)
  | ({ do: 'fill'; text: string; submit?: boolean; clear?: boolean; dialog?: 'accept' | 'dismiss' } & ElementTarget)
  | ({ do: 'select'; value: string } & ElementTarget)
  | { do: 'wait'; text?: string; url?: string; selector?: string; gone?: boolean; timeoutMs?: number }
  | { do: 'snapshot'; limit?: number }
  | { do: 'screenshot'; fullPage?: boolean }
  | ({ do: 'hover' | 'scroll' } & ElementTarget)
  | ({ do: 'upload'; files: string[] } & ElementTarget);

/** A frame a snapshot read: its frame id, and the document its refs act on. */
export interface SnapshotFrame {
  id: string;
  document?: string;
}

/** What a script printed and left in `result`, or the traceback it died with. */
export interface ScriptOutcome extends Happened {
  output: string;
  /** Output past 64 KB was dropped. */
  truncated: boolean;
  result: unknown;
  /** The result's JSON was over 64 KB, so `result` is that JSON as a string, cut. */
  resultTruncated: boolean;
  ms: number;
  error?: string;
}

/** What one action did. `skipped` follows an earlier failure; `error` is that failure. */
export interface ActionOutcome extends Happened {
  do: PageAction['do'];
  ok: boolean;
  skipped?: boolean;
  error?: string;
  url?: string;
  loaded?: boolean;
  ref?: string;
  navigated?: boolean;
  /** A click's checks ran; false when it was forced. */
  checked?: boolean;
  /** The option a `select` chose, by its text. */
  selected?: string;
  /** A snapshot's document: its refs act only there. */
  document?: string;
  /** A snapshot's frames, by number (`f1`): the refs `f<k>e<n>` act in their frame's document. */
  frames?: Record<string, SnapshotFrame>;
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
      return {
        ...base,
        do: 'click',
        ...target(a),
        ...(a.force ? { force: true } : {}),
        ...(a.loadTimeoutMs !== undefined ? { loadTimeoutMs: a.loadTimeoutMs } : {}),
        ...(a.dialog ? { dialog: a.dialog } : {}),
        timeoutMs: 30_000,
      };
    case 'fill':
      return {
        ...base,
        do: 'fill',
        ...target(a),
        text: a.text,
        ...(a.submit ? { submit: true } : {}),
        ...(a.clear === false ? { clear: false } : {}),
        ...(a.dialog ? { dialog: a.dialog } : {}),
        timeoutMs: 30_000,
      };
    case 'select':
      return { ...base, do: 'select', ...target(a), value: a.value, timeoutMs: 30_000 };
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
      return { ...base, do: 'snapshot', timeoutMs: 30_000 };
    case 'hover':
    case 'scroll':
      return { ...base, do: a.do, ...target(a), timeoutMs: 30_000 };
    case 'upload':
      return { ...base, do: 'upload', ...target(a), files: a.files, timeoutMs: 30_000 };
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
  // A failure says what else happened on the way, too: a dialog, a load the policy stopped.
  if (typeof r['error'] === 'string') return { do: a.do, ok: false, error: r['error'], ...happenedOf(r as Happened) };
  const out: ActionOutcome = { do: a.do, ok: true };
  if (typeof r['url'] === 'string') out.url = r['url'];
  if (typeof r['loaded'] === 'boolean') out.loaded = r['loaded'];
  if (typeof r['ref'] === 'string') out.ref = r['ref'];
  if (typeof r['navigated'] === 'boolean') out.navigated = r['navigated'];
  if (typeof r['checked'] === 'boolean') out.checked = r['checked'];
  if (typeof r['selected'] === 'string') out.selected = r['selected'];
  if (typeof r['document'] === 'string') out.document = r['document'];
  if (r['frames'] && typeof r['frames'] === 'object') out.frames = r['frames'] as Record<string, SnapshotFrame>;
  if (Array.isArray(r['dialogs'])) out.dialogs = r['dialogs'] as NonNullable<Happened['dialogs']>;
  if (Array.isArray(r['downloads'])) out.downloads = r['downloads'] as NonNullable<Happened['downloads']>;
  if (Array.isArray(r['popups'])) out.popups = r['popups'] as NonNullable<Happened['popups']>;
  if (Array.isArray(r['blocked'])) out.blocked = r['blocked'] as NonNullable<Happened['blocked']>;
  if (typeof r['waitedMs'] === 'number') out.waitedMs = r['waitedMs'];
  if (typeof r['data'] === 'string') out.data = r['data'];
  if (a.do === 'snapshot') {
    const nodes = Array.isArray(r['nodes']) ? (r['nodes'] as AxNodeLike[]) : [];
    out.nodes = snapshotOf(nodes, r['unreachable'], a.limit !== undefined ? { limit: a.limit } : {});
  }
  return out;
}

/** The compact tree, plus a line saying which frames could not be read. */
function snapshotOf(nodes: AxNodeLike[], unreachable: unknown, opts: { limit?: number }): SnapshotNode[] {
  const tree = compactAxTree(nodes, opts);
  if (Array.isArray(unreachable) && unreachable.length > 0) {
    tree.push({
      ref: 'x0',
      role: 'UnreachableFrames',
      name:
        `${unreachable.length} iframe${unreachable.length === 1 ? '' : 's'} on this page ` +
        `could not be read, so nothing in ${unreachable.length === 1 ? 'it' : 'them'} is listed: ${unreachable.slice(0, 10).map(String).join(', ')}`,
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


