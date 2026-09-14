import { describe, expect, it } from 'vitest';
import { backendNodeIdOf, flattenAxTree } from '@husk-ai/browser';
import type { SnapshotNode } from '../api/wire';
import { latestProgressFor,
  actionableNodes,
  changesPage,
  classifyBrowserError,
  debugPortIsShared,
  followUps,
  isActionable,
  isActionableRef,
  isTextInput,
  nodeLabel,
  normaliseUrl,
} from './browserModel';
import type { PageAction } from './browserModel';

const node = (over: Partial<SnapshotNode>): SnapshotNode => ({
  ref: 'e1',
  role: 'button',
  name: 'OK',
  ...over,
});

describe('ref selection', () => {
  it('accepts the e<backendDOMNodeId> refs click can resolve', () => {
    expect(isActionableRef('e1')).toBe(true);
    expect(isActionableRef('e40219')).toBe(true);
  });

  it('rejects the informational a-prefixed refs', () => {
    // `Page.click` throws E_TOOL_ERROR on these, so offering the row is a
    // button that is known in advance to fail.
    expect(isActionableRef('a12')).toBe(false);
    expect(isActionableRef('e')).toBe(false);
    expect(isActionableRef('e1x')).toBe(false);
    expect(isActionableRef('')).toBe(false);
  });

  it('agrees with @husk-ai/browser about which refs resolve', () => {
    // The contract, not our restatement of it: whatever `backendNodeIdOf`
    // resolves is exactly what this panel is allowed to offer.
    for (const ref of ['e1', 'e999', 'a1', 'a', 'e', 'exyz', '']) {
      expect(isActionableRef(ref)).toBe(backendNodeIdOf(ref) !== null);
    }
  });

  it('keeps interactive roles and drops static text', () => {
    expect(isActionable(node({ role: 'button' }))).toBe(true);
    expect(isActionable(node({ role: 'link' }))).toBe(true);
    expect(isActionable(node({ role: 'textbox' }))).toBe(true);
    expect(isActionable(node({ role: 'paragraph', name: 'hello' }))).toBe(false);
    expect(isActionable(node({ role: 'heading', name: 'Title' }))).toBe(false);
  });

  it('drops an interactive role that carries an unusable ref', () => {
    expect(isActionable(node({ ref: 'a7', role: 'button' }))).toBe(false);
  });

  it('separates typing targets from clicking targets', () => {
    expect(isTextInput(node({ role: 'textbox' }))).toBe(true);
    expect(isTextInput(node({ role: 'searchbox' }))).toBe(true);
    expect(isTextInput(node({ role: 'textarea' }))).toBe(true);
    expect(isTextInput(node({ role: 'button' }))).toBe(false);
    expect(isTextInput(node({ role: 'link' }))).toBe(false);
  });

  it('preserves tree order and caps the list', () => {
    const nodes = Array.from({ length: 500 }, (_, i) => node({ ref: `e${i}`, name: `b${i}` }));
    const picked = actionableNodes(nodes, 3);
    expect(picked.map((n) => n.ref)).toEqual(['e0', 'e1', 'e2']);
  });

  it('survives a real flattened tree', () => {
    const nodes = flattenAxTree([
      { role: { value: 'RootWebArea' }, name: { value: 'doc' }, backendDOMNodeId: 1 },
      { role: { value: 'button' }, name: { value: 'Reveal' }, backendDOMNodeId: 12 },
      { role: { value: 'paragraph' }, name: { value: 'hello' }, backendDOMNodeId: 13 },
      { role: { value: 'textbox' }, name: { value: 'Search' }, backendDOMNodeId: 14 },
      // No backendDOMNodeId: informational, so not offerable.
      { role: { value: 'button' }, name: { value: 'Ghost' }, nodeId: '99' },
    ]);
    expect(actionableNodes(nodes).map((n) => n.ref)).toEqual(['e12', 'e14']);
  });

  it('names a row even when the node has none', () => {
    expect(nodeLabel(node({ name: 'Sign in' }))).toBe('Sign in');
    expect(nodeLabel(node({ name: '', value: 'draft text' }))).toBe('draft text');
    expect(nodeLabel(node({ ref: 'e9', role: 'button', name: '' }))).toBe('(unnamed button e9)');
  });
});

describe('refresh after mutation', () => {
  const ALL: PageAction[] = ['goto', 'click', 'type', 'snapshot', 'screenshot'];

  it('marks exactly the page-changing actions', () => {
    expect(ALL.filter(changesPage)).toEqual(['goto', 'click', 'type']);
  });

  it('refreshes the screenshot after every action that changes the page', () => {
    for (const action of ALL) {
      expect(followUps(action).includes('screenshot')).toBe(changesPage(action));
    }
  });

  it('asks for a snapshot only where the response does not carry one', () => {
    // click and type return `{ url, nodes }`; goto returns `{ url, loaded, title }`.
    expect(followUps('goto')).toEqual(['snapshot', 'screenshot']);
    expect(followUps('click')).toEqual(['screenshot']);
    expect(followUps('type')).toEqual(['screenshot']);
  });

  it('adds nothing after a read', () => {
    expect(followUps('snapshot')).toEqual([]);
    expect(followUps('screenshot')).toEqual([]);
  });
});

describe('error mapping', () => {
  it('treats a policy refusal as policy, not breakage', () => {
    const f = classifyBrowserError({ code: 'E_EXEC_DENIED', message: 'network policy refuses evil.test' });
    expect(f.kind).toBe('denied');
    expect(f.suggestTextView).toBe(false);
  });

  it('offers the text view when Chromium cannot be installed', () => {
    for (const code of ['E_NOT_IMPLEMENTED', 'E_PROVIDER_UNAVAILABLE']) {
      const f = classifyBrowserError({ code, message: 'nope' });
      expect(f.kind).toBe('unavailable');
      expect(f.suggestTextView).toBe(true);
    }
  });

  it('separates a failed launch from a failed install', () => {
    for (const code of ['E_COMPUTER_FAILED', 'E_EXEC_TIMEOUT', 'E_EXEC_FAILED', 'E_INTERNAL']) {
      expect(classifyBrowserError({ code, message: 'x' }).kind).toBe('launch');
    }
  });

  it('reads a tool error as a stale ref and offers a new snapshot', () => {
    const f = classifyBrowserError({ code: 'E_TOOL_ERROR', message: 'e12 is no longer on the page' });
    expect(f.kind).toBe('stale-ref');
    expect(f.suggestSnapshot).toBe(true);
  });

  it('never invents a category it does not have', () => {
    const f = classifyBrowserError({ code: 'E_SOMETHING_NEW', message: 'x' });
    expect(f.kind).toBe('unknown');
    expect(f.body).not.toMatch(/went wrong/i);
  });

  it('says what state the system is in now, in every branch', () => {
    for (const code of ['E_EXEC_DENIED', 'E_PROVIDER_UNAVAILABLE', 'E_EXEC_FAILED', 'E_TOOL_ERROR', 'E_X']) {
      expect(classifyBrowserError({ code, message: 'x' }).body.length).toBeGreaterThan(40);
    }
  });
});

describe('the debug-port note', () => {
  it('fires on providers that share the host network stack', () => {
    expect(debugPortIsShared('local')).toBe(true);
    expect(debugPortIsShared('ssh')).toBe(true);
  });

  it('stays quiet where the computer owns its own namespace', () => {
    expect(debugPortIsShared('docker')).toBe(false);
    expect(debugPortIsShared('podman')).toBe(false);
    expect(debugPortIsShared('fly')).toBe(false);
  });
});

describe('normaliseUrl', () => {
  it('adds https to a bare host and leaves a scheme alone', () => {
    expect(normaliseUrl('example.com')).toBe('https://example.com');
    expect(normaliseUrl('  example.com ')).toBe('https://example.com');
    expect(normaliseUrl('http://127.0.0.1:8111/')).toBe('http://127.0.0.1:8111/');
    expect(normaliseUrl('')).toBeNull();
    expect(normaliseUrl('   ')).toBeNull();
  });
});

/**
 * The panel used to say, in as many words, that the console was not sent any
 * progress: `browserFor` in `routes/browser.ts` passed no `onProgress`, so the
 * provisioner's narration went to the server log and stopped there. A 111 MB
 * download showed a seconds counter and nothing else.
 */
describe('latestProgressFor', () => {
  const ev = (type: string, payload: unknown) => ({ type, payload });

  it('finds the newest message for the computer on screen', () => {
    // The feed is newest-first, so the newest matching event wins by position.
    const events = [
      ev('browser_progress', { id: 'c1', message: 'unpacking 111 MB' }),
      ev('browsed', { id: 'c1', url: 'https://example.com' }),
      ev('browser_progress', { id: 'c1', message: 'downloading Chromium' }),
    ];
    expect(latestProgressFor(events, 'c1')).toBe('unpacking 111 MB');
  });

  it('ignores another machine downloading at the same time', () => {
    const events = [ev('browser_progress', { id: 'c2', message: 'unpacking' })];
    expect(latestProgressFor(events, 'c1')).toBeNull();
  });

  it('is null with no computer selected, and with an empty feed', () => {
    expect(latestProgressFor([ev('browser_progress', { id: 'c1', message: 'x' })], null)).toBeNull();
    expect(latestProgressFor([], 'c1')).toBeNull();
  });

  it('does not render a blank or malformed payload as a message', () => {
    // An empty string would clear nothing and show an empty "Now:" line.
    expect(latestProgressFor([ev('browser_progress', { id: 'c1', message: '   ' })], 'c1')).toBeNull();
    expect(latestProgressFor([ev('browser_progress', { id: 'c1' })], 'c1')).toBeNull();
    expect(latestProgressFor([ev('browser_progress', null)], 'c1')).toBeNull();
  });
});
