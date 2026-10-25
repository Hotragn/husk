import { describe, expect, it } from 'vitest';
import type { CdpConnection } from './cdp.js';
import { Page } from './page.js';

/**
 * What saves a model a turn: a page status in every result, a snapshot of only
 * the part of the page it needs, and a wait that rides on the action that
 * causes it. A fake connection answers as the driver would.
 */

type Step = { op: string; method?: string; do?: string; [k: string]: unknown };

function fakePage(answers: { status?: unknown; tabs?: string[]; action?: (step: Step) => unknown }) {
  const steps: Step[] = [];
  const conn = {
    async run(list: Step[]) {
      return list.map((s) => {
        steps.push(s);
        if (s.method === 'Runtime.evaluate') return { result: { value: answers.status } };
        if (s.method === 'Target.getTargets') return { targetInfos: (answers.tabs ?? ['page']).map((type) => ({ type })) };
        if (s.op === 'action') return answers.action?.(s) ?? {};
        return {};
      });
    },
  } as unknown as CdpConnection;
  return { page: new Page(conn, 'T1'), steps };
}

describe('the page status line', () => {
  it('says where the page is, whether it has loaded, and how many tabs are open when more than one', async () => {
    const { page } = fakePage({ status: { url: 'https://example.com/', title: 'Example', ready: 'complete' }, tabs: ['page', 'page', 'iframe'] });
    await expect(page.status()).resolves.toBe('now at https://example.com/ -- "Example", loaded; 2 tabs are open (browser_tabs lists them)');
    const { page: one } = fakePage({ status: { url: 'https://example.com/a', title: '', ready: 'interactive' } });
    await expect(one.status()).resolves.toBe('now at https://example.com/a -- untitled, still loading');
  });
});

describe('a snapshot of part of the page', () => {
  const nodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '3'] },
    { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Welcome' }, backendDOMNodeId: 2 },
    { nodeId: '3', parentId: '1', role: { value: 'form' }, name: { value: 'Sign in' }, backendDOMNodeId: 3, childIds: ['4', '5'] },
    { nodeId: '4', parentId: '3', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 4 },
    { nodeId: '5', parentId: '3', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 5 },
  ];

  it('lists only what is under the ref, the ref first', async () => {
    const { page } = fakePage({ action: () => ({ nodes, document: 'L1', url: 'https://example.com/' }) });
    await expect(page.snapshot({ root: 'e3' })).resolves.toEqual([
      { ref: 'e3', role: 'form', name: 'Sign in', depth: 0 },
      { ref: 'e4', role: 'textbox', name: 'Email', depth: 1 },
      { ref: 'e5', role: 'button', name: 'Go', depth: 1 },
    ]);
  });

  it('says so when the page has no such ref', async () => {
    const { page } = fakePage({ action: () => ({ nodes, document: 'L1', url: 'https://example.com/' }) });
    await expect(page.snapshot({ root: 'e9' })).rejects.toThrow(/e9 is not on the page/);
  });
});

describe('a wait that rides on its click', () => {
  it('is armed in the same driver step as the click, and what it found comes back', async () => {
    const waited = { what: 'text "Saved"', found: true, waitedMs: 12 };
    const { page, steps } = fakePage({ action: (s) => (s.do === 'click' ? { ref: 'e7', navigated: false, checked: true, waited } : {}) });
    const out = await page.click('e7', 5000, { waitFor: { text: 'Saved', timeoutMs: 2000 } });
    expect(out.waited).toEqual(waited);
    const click = steps.find((s) => s.do === 'click')!;
    expect(String(click['arm'])).toContain('MutationObserver');
    expect(click['wait']).toMatchObject({ what: 'text "Saved"', expression: expect.stringContaining('__huskArmed') });
    // The step's own budget covers the wait.
    expect(click['timeoutMs']).toBe(32_000);
  });
});
