import { HuskError } from '@husk/core';
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
}

export interface SnapshotNode {
  /** Handle to pass to `click` / `type`. Derived from the DOM node, so it survives a re-snapshot. */
  ref: string;
  role: string;
  name: string;
  value?: string;
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
 * There is deliberately no long-lived session id here. A CDP session belongs to
 * a websocket, and this package's websockets last exactly one driver
 * invocation; a target id belongs to the browser and outlives all of them. So
 * the driver re-attaches on every call, and the domain enables a fresh session
 * needs are replayed as a prelude. Three extra commands on a loopback socket
 * cost well under a millisecond; getting this wrong costs a protocol error on
 * every second call.
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

  async snapshot(opts: { limit?: number } = {}): Promise<SnapshotNode[]> {
    const [, tree] = await this.run([
      { op: 'send', method: 'Accessibility.enable', session: true },
      { op: 'send', method: 'Accessibility.getFullAXTree', session: true },
    ]);
    const res = (tree ?? {}) as CdpParams;
    const nodes = Array.isArray(res['nodes']) ? (res['nodes'] as AxNodeLike[]) : [];
    return flattenAxTree(nodes, opts);
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

  async click(ref: string): Promise<void> {
    const { x, y } = await this.centreOf(ref);
    const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
    await this.run([
      { op: 'send', method: 'Input.dispatchMouseEvent', params: { ...base, type: 'mousePressed' }, session: true },
      {
        op: 'send',
        method: 'Input.dispatchMouseEvent',
        params: { ...base, type: 'mouseReleased', buttons: 0 },
        session: true,
      },
    ]);
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
