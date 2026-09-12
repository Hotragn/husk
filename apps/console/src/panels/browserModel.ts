/**
 * The parts of the Browser panel that are decisions rather than markup.
 *
 * All of this is here rather than inside the component for one reason: every
 * function below encodes a rule that would rot silently if it were an `if`
 * halfway down a 600-line render. Which refs can be clicked, what has to happen
 * after something changes the page, and what a failure code means are exactly
 * the three things that break quietly when the endpoints move.
 */

import type { DisplayError } from '../api/client';
import type { SnapshotNode } from '../api/wire';
import { sharesHostNetwork } from '@husk/core';

/**
 * Refs `click` and `type` can actually resolve.
 *
 * `flattenAxTree` in `@husk/browser` mints two kinds: `e<backendDOMNodeId>` for
 * a node it can point CDP at, and `a<n>` for one it cannot. `backendNodeIdOf`
 * returns null for the second kind and `Page.click` then throws
 * `E_TOOL_ERROR: <ref> is not a clickable element`. Filtering here means the
 * panel never offers a row whose click is already known to fail.
 */
export function isActionableRef(ref: string): boolean {
  return /^e\d+$/.test(ref);
}

/**
 * Roles worth putting a control on. Mirrors `INTERACTIVE_ROLES` in
 * `packages/browser/src/page.ts` — the snapshot keeps nodes with these roles
 * even when they are unnamed, which is the same judgement being made here.
 */
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

/** Roles where the useful verb is "type into", not "click". */
const TEXT_ENTRY_ROLES: ReadonlySet<string> = new Set([
  'textbox',
  'searchbox',
  'textarea',
  'spinbutton',
  'combobox',
]);

export function isTextInput(node: SnapshotNode): boolean {
  return TEXT_ENTRY_ROLES.has(node.role);
}

/** A node the panel can offer an action on: resolvable ref, interactive role. */
export function isActionable(node: SnapshotNode): boolean {
  return isActionableRef(node.ref) && INTERACTIVE_ROLES.has(node.role);
}

/** The interactive nodes, in tree order, capped so a huge page stays scannable. */
export function actionableNodes(nodes: readonly SnapshotNode[], limit = 200): SnapshotNode[] {
  const out: SnapshotNode[] = [];
  for (const node of nodes) {
    if (out.length >= limit) break;
    if (isActionable(node)) out.push(node);
  }
  return out;
}

/**
 * What to call a row.
 *
 * An unnamed control is a real thing on real pages — an icon button with no
 * `aria-label`, a bare input. Naming it by role and ref is worse than a name
 * and much better than an empty row, which looks like a rendering bug.
 */
export function nodeLabel(node: SnapshotNode): string {
  if (node.name) return node.name;
  if (node.value) return node.value;
  return `(unnamed ${node.role} ${node.ref})`;
}

/** Everything the panel asks the browser to do. */
export type PageAction = 'goto' | 'click' | 'type' | 'snapshot' | 'screenshot';

/** True when the action can leave the page in a different state than it found it. */
export function changesPage(action: PageAction): boolean {
  return action === 'goto' || action === 'click' || action === 'type';
}

/**
 * What must run after an action, in order.
 *
 * The rule: anything that changes the page is followed by a fresh screenshot,
 * because a still of the previous state under a new URL is a lie — the same
 * class of bug the Files panel shipped once. `click` and `type` return the new
 * snapshot in their own response, so only `goto` has to ask for one.
 */
export function followUps(action: PageAction): readonly ('snapshot' | 'screenshot')[] {
  if (action === 'goto') return ['snapshot', 'screenshot'];
  if (action === 'click' || action === 'type') return ['screenshot'];
  return [];
}

export interface BrowserFailure {
  /** Which explanation the panel renders alongside the server's own message. */
  kind: 'denied' | 'unavailable' | 'launch' | 'stale-ref' | 'unknown';
  /** A sentence about what state things are in now, not a restatement of the code. */
  body: string;
  /** Whether the text view is a useful thing to offer instead. */
  suggestTextView: boolean;
  /** Whether a fresh snapshot is the fix. */
  suggestSnapshot: boolean;
}

/**
 * Map a failure onto the one thing the reader should do next.
 *
 * The server's `code`, `message` and `hint` are rendered verbatim by
 * `ErrorBlock` either way; this only decides what goes next to them. Codes come
 * from `packages/browser/src/*.ts` and `assertUrlAllowed` in `@husk/core`.
 */
export function classifyBrowserError(err: DisplayError): BrowserFailure {
  switch (err.code) {
    case 'E_EXEC_DENIED':
      return {
        kind: 'denied',
        body:
          "The URL never reached Chromium. The check runs on the parsed URL inside the session, before it navigates, so nothing was fetched and the browser is still on whatever page it was already showing.",
        suggestTextView: false,
        suggestSnapshot: false,
      };
    case 'E_NOT_IMPLEMENTED':
    case 'E_PROVIDER_UNAVAILABLE':
      return {
        kind: 'unavailable',
        body:
          'Chromium could not be installed in this machine, so there is no browser to drive. The text view needs nothing installed and still works.',
        suggestTextView: true,
        suggestSnapshot: false,
      };
    case 'E_COMPUTER_FAILED':
    case 'E_EXEC_TIMEOUT':
    case 'E_EXEC_FAILED':
    case 'E_INTERNAL':
      return {
        kind: 'launch',
        body:
          'Chromium is installed but the driver call did not come back cleanly. The computer itself is untouched and its files are intact; the browser will be relaunched on the next load.',
        suggestTextView: true,
        suggestSnapshot: false,
      };
    case 'E_TOOL_ERROR':
      return {
        kind: 'stale-ref',
        body:
          'That ref no longer resolves to a node in the document — the page moved on between the snapshot and the click. Take a new snapshot and the refs below will match what is on screen.',
        suggestTextView: false,
        suggestSnapshot: true,
      };
    default:
      return {
        kind: 'unknown',
        body: 'The page on screen is whatever was there before this call; nothing above has been refreshed.',
        suggestTextView: false,
        suggestSnapshot: true,
      };
  }
}


/**
 * Whether Chromium's debug port is reachable by other processes on the host.
 *
 * Husk binds it to the computer's loopback and publishes nothing. On a provider
 * that shares a network stack with the host that is not containment — WSL2
 * forwards loopback listeners to Windows by itself — and CDP has no
 * authentication. Same condition as `warnIfDebugPortIsExposed`.
 */
export function debugPortIsShared(provider: string): boolean {
  return sharesHostNetwork(provider);
}

/**
 * `example.com` is what a person types; `https://example.com` is what the route
 * needs. Anything that already carries a scheme is left exactly as typed —
 * including `http://`, because a user asking for cleartext usually means it.
 */
export function normaliseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The most recent provisioning message for this computer, if any.
 *
 * The server emits `computers/browser_progress` as the browser is installed and
 * started -- "downloading Chromium for arm64 (~111 MB)", "unpacking", "starting
 * Chromium and waiting for its debugger", "Chromium ready". Before this the
 * console had only a seconds counter and said so.
 *
 * Stages, not bytes. The download runs inside the computer, so no byte count
 * crosses the boundary and none is drawn.
 *
 * `events` is newest-first, which is why this returns the first match rather
 * than the last.
 */
export function latestProgressFor(
  events: readonly { type: string; payload?: unknown }[],
  computerId: string | null,
): string | null {
  if (!computerId) return null;
  for (const event of events) {
    if (event.type !== 'browser_progress') continue;
    const payload = event.payload as { id?: unknown; message?: unknown } | undefined;
    if (payload?.id !== computerId) continue;
    return typeof payload.message === 'string' && payload.message.trim() !== '' ? payload.message : null;
  }
  return null;
}
