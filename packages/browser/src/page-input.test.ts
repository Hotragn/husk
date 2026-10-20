import { describe, expect, it } from 'vitest';
import type { CdpConnection } from './cdp.js';
import { Page } from './page.js';

/** Records every CDP method a Page sends, and answers the two a frame reads. */
function recordingPage(): { page: Page; methods: string[] } {
  const methods: string[] = [];
  const conn = {
    async run(steps: Array<{ method?: string }>) {
      return steps.map((s) => {
        if (s.method) methods.push(s.method);
        if (s.method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
        if (s.method === 'Page.captureScreenshot') return { data: 'abc' };
        return {};
      });
    },
  } as unknown as CdpConnection;
  return { page: new Page(conn, 'target-1'), methods };
}

const PRELUDE = new Set(['Page.enable', 'Runtime.enable', 'DOM.enable']);

describe('person input', () => {
  it('sends only Input.* commands: a mouse and a keyboard, never script', async () => {
    const { page, methods } = recordingPage();
    await page.clickAt(10, 20, { button: 'right', clickCount: 2 });
    await page.wheelAt(10, 20, 0, 300);
    await page.insertText('hunter2');
    await page.press('Enter');
    const sent = methods.filter((m) => !PRELUDE.has(m));
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) expect(m).toMatch(/^Input\./);
  });

  it('reads a frame and its CSS viewport in one invocation', async () => {
    const { page, methods } = recordingPage();
    await expect(page.frame()).resolves.toEqual({ data: 'abc', width: 800, height: 600 });
    expect(methods.filter((m) => !PRELUDE.has(m))).toEqual(['Page.getLayoutMetrics', 'Page.captureScreenshot']);
  });
});
