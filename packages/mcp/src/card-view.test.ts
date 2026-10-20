/**
 * The card's own script, run in a DOM against a fake host.
 *
 * Checks the handshake the MCP Apps spec asks of a view (ui/initialize, then
 * ui/notifications/initialized), that host and model text is rendered as text,
 * and that it only ever asks the host to open a loopback link.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { CARD_HTML } from './card.js';

type Msg = { jsonrpc: string; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
const open: JSDOM[] = [];
afterEach(() => {
  for (const d of open.splice(0)) d.window.close();
});

function mount() {
  const host = new JSDOM('').window;
  const sent: Msg[] = [];
  (host as unknown as { postMessage: (m: Msg) => void }).postMessage = (m) => sent.push(m);
  const dom = new JSDOM(CARD_HTML, {
    runScripts: 'dangerously',
    beforeParse(w) {
      Object.defineProperty(w, 'parent', { value: host });
    },
  });
  open.push(dom);
  const deliver = (data: unknown, source: unknown = host) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: source as never }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const $ = (sel: string) => dom.window.document.querySelector(sel)!;
  return { sent, deliver, tick, $, dom };
}

async function connected() {
  const m = mount();
  const init = m.sent.find((x) => x.method === 'ui/initialize');
  expect(init?.params).toMatchObject({ protocolVersion: '2026-01-26', appInfo: { name: 'husk-computer-card' } });
  m.deliver({ jsonrpc: '2.0', id: init!.id, result: { protocolVersion: '2026-01-26', hostContext: {} } });
  await m.tick();
  return m;
}

describe('the computer card view', () => {
  it('does the MCP Apps handshake before anything else', async () => {
    const m = await connected();
    expect(m.sent.map((x) => x.method).slice(0, 2)).toEqual(['ui/initialize', 'ui/notifications/initialized']);
  });

  it('shows the state, with model and host text as text', async () => {
    const m = await connected();
    m.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { computerId: 'cmp_1', state: 'running', label: '<img src=x onerror=alert(1)>' } },
    });
    expect(m.$('.title').textContent).toBe('Computer running');
    expect(m.$('.sub').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(m.dom.window.document.querySelector('img')).toBeNull();
    expect(m.$('button').textContent).toBe('Open');

    m.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { computerId: 'cmp_1', state: 'running', waiting: { handoffId: 'hnd_1', reason: 'Sign in.' } } },
    });
    expect(m.$('.title').textContent).toBe('Waiting for you');
    expect(m.$('.sub').textContent).toBe('Sign in.');
    expect(m.$('button').textContent).toBe('Take over');
  });

  it('asks for a fresh link on click and has the host open it', async () => {
    const m = await connected();
    m.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { computerId: 'cmp_1', state: 'running' } } });
    m.$('button').click();
    const call = m.sent.find((x) => x.method === 'tools/call');
    expect(call?.params).toEqual({ name: 'computer_card_link', arguments: { computer: 'cmp_1' } });
    const url = 'http://127.0.0.1:5555/#computer=cmp_1&token=' + 'a'.repeat(64);
    m.deliver({ jsonrpc: '2.0', id: call!.id, result: { structuredContent: { url } } });
    await m.tick();
    expect(m.sent.find((x) => x.method === 'ui/open-link')?.params).toEqual({ url });
  });

  it('never asks the host to open anything but a loopback link', async () => {
    const m = await connected();
    m.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { computerId: 'cmp_1', state: 'running' } } });
    m.$('button').click();
    const call = m.sent.find((x) => x.method === 'tools/call');
    m.deliver({ jsonrpc: '2.0', id: call!.id, result: { structuredContent: { url: 'https://evil.example/' } } });
    await m.tick();
    expect(m.sent.some((x) => x.method === 'ui/open-link')).toBe(false);
  });

  it('ignores messages that do not come from the host', async () => {
    const m = await connected();
    const stranger = new JSDOM('').window;
    m.deliver(
      { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { computerId: 'cmp_x', state: 'running' } } },
      stranger,
    );
    expect(m.$('.title').textContent).toBe('Husk computer');
    stranger.close();
  });
});
