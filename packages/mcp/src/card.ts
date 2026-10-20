/**
 * The in-chat computer card, an MCP Apps view.
 * Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 *
 * It shows "Computer running · Open" or "Waiting for you · Take over" for one
 * chat's computer. It makes no network requests of its own: the host renders
 * it in a sandboxed iframe, and it talks to Husk only through the host, by
 * calling two app-only tools (`computer_card_state`, `computer_card_link`) and
 * asking the host to open the link it gets back (`ui/open-link`). The link
 * carries a short-lived token scoped to that one computer.
 *
 * Hand-written rather than built on @modelcontextprotocol/ext-apps, which needs
 * MCP SDK v2 and a bundler: the view's side of the protocol is five messages.
 * Everything from the model or the host is set with textContent, never as HTML.
 */

import type { ToolDef } from './tools.js';

export const CARD_URI = 'ui://husk/computer-card.html';
export const CARD_MIME = 'text/html;profile=mcp-app';
export const UI_EXTENSION = 'io.modelcontextprotocol/ui';

export const CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Husk computer</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.4 var(--font-sans, system-ui, sans-serif); color: var(--color-text-primary, CanvasText); background: transparent; }
  .card { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--color-border-primary, #8884); border-radius: var(--border-radius-md, 8px); background: var(--color-background-secondary, Canvas); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #2e9e5b; flex: none; }
  .card[data-state="waiting"] { border-color: #d48806; }
  .card[data-state="waiting"] .dot { background: #d48806; }
  .card[data-state="stopped"] .dot, .card[data-state="unknown"] .dot { background: #8a8a8a; }
  .text { flex: 1; min-width: 0; }
  .title { font-weight: 600; }
  .sub { color: var(--color-text-secondary, GrayText); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card[data-state="waiting"] .sub { white-space: normal; }
  button { font: inherit; padding: 6px 12px; border-radius: var(--border-radius-sm, 6px); border: 1px solid var(--color-border-primary, #8886); background: var(--color-background-primary, Canvas); color: inherit; cursor: pointer; }
  .card[data-state="waiting"] button { background: #d48806; border-color: #d48806; color: #fff; }
  button:disabled { opacity: .6; cursor: default; }
</style>
</head>
<body>
<div class="card" data-state="unknown" role="status" aria-live="polite">
  <span class="dot" aria-hidden="true"></span>
  <div class="text"><div class="title">Husk computer</div><div class="sub">Connecting…</div></div>
  <button type="button" hidden>Open</button>
</div>
<script>
(() => {
  const card = document.querySelector('.card');
  const title = card.querySelector('.title');
  const sub = card.querySelector('.sub');
  const button = card.querySelector('button');
  let computer = null;
  let lastSize = '';
  let nextId = 1;
  const pending = new Map();

  const send = (msg) => window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, msg), '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

  function show(state) {
    if (!state || typeof state.computerId !== 'string') return;
    computer = state.computerId;
    const waiting = state.waiting && typeof state.waiting.reason === 'string';
    const kind = waiting ? 'waiting' : state.state === 'running' ? 'running' : state.state === 'stopped' ? 'stopped' : 'unknown';
    card.dataset.state = kind;
    title.textContent = waiting ? 'Waiting for you' : kind === 'running' ? 'Computer running' : kind === 'stopped' ? 'Computer stopped' : 'Husk computer';
    sub.textContent = waiting ? state.waiting.reason : (typeof state.label === 'string' ? state.label : '');
    button.textContent = waiting ? 'Take over' : 'Open';
    button.hidden = false;
    // Only when it changes, as the spec's own view library does.
    const width = document.body.scrollWidth;
    const height = document.body.scrollHeight;
    if (width + 'x' + height !== lastSize) {
      lastSize = width + 'x' + height;
      send({ method: 'ui/notifications/size-changed', params: { width, height } });
    }
  }

  async function refresh() {
    // A card scrolled out of a long chat, or in a hidden window, need not ask.
    if (!computer || document.hidden) return;
    try {
      const r = await request('tools/call', { name: 'computer_card_state', arguments: { computer } });
      show(r && r.structuredContent);
    } catch (e) { /* the next poll tries again */ }
  }

  button.addEventListener('click', async () => {
    if (!computer) return;
    button.disabled = true;
    try {
      const r = await request('tools/call', { name: 'computer_card_link', arguments: { computer } });
      const url = r && r.structuredContent && r.structuredContent.url;
      if (typeof url === 'string' && /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\//.test(url)) await request('ui/open-link', { url });
    } catch (e) {
      sub.textContent = 'Could not open it. Ask your AI to open the computer.';
    } finally {
      button.disabled = false;
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && !msg.method && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'ping' && msg.id !== undefined) return send({ id: msg.id, result: {} });
    if (msg.method === 'ui/notifications/tool-result') show(msg.params && msg.params.structuredContent);
    if (msg.method === 'ui/notifications/host-context-changed') theme(msg.params);
  });

  function theme(ctx) {
    const vars = ctx && ctx.styles && ctx.styles.variables;
    if (!vars) return;
    for (const [k, v] of Object.entries(vars)) if (k.startsWith('--') && typeof v === 'string') document.documentElement.style.setProperty(k, v);
  }

  request('ui/initialize', {
    appInfo: { name: 'husk-computer-card', version: '1' },
    appCapabilities: {},
    protocolVersion: '2026-01-26',
  }).then((result) => {
    theme(result && result.hostContext);
    send({ method: 'ui/notifications/initialized' });
    setInterval(refresh, 5000);
  }, () => { sub.textContent = 'This app cannot show Husk cards.'; });
})();
</script>
</body>
</html>
`;

const computerArg = {
  type: 'object',
  properties: { computer: { type: 'string', description: 'The computer id the card was given.' } },
  required: ['computer'],
};

/** Called by the card through the host, never by the model (`visibility: ["app"]`). */
export const CARD_APP_TOOLS: ToolDef[] = [
  {
    name: 'computer_card_state',
    description: "The card's view of one computer: running, stopped, or waiting for the user.",
    inputSchema: computerArg,
    _meta: { ui: { resourceUri: CARD_URI, visibility: ['app'] } },
  },
  {
    name: 'computer_card_link',
    description: 'A fresh, short-lived link to look at one computer, or take over its handoff.',
    inputSchema: computerArg,
    _meta: { ui: { resourceUri: CARD_URI, visibility: ['app'] } },
  },
];

export const CARD_APP_TOOL_NAMES = new Set(CARD_APP_TOOLS.map((t) => t.name));

/** The plain-link fallback, for clients that do not render cards. */
export const OPEN_UI_TOOL: ToolDef = {
  name: 'computer_open_ui',
  description:
    "Get a link the user can open on this device to see this chat's computer, and take over if it is " +
    'waiting for them. Use it when the user asks to see the computer. The link expires after 10 minutes unused.',
  inputSchema: { type: 'object', properties: {} },
};

/** What the card shows. Never carries a token; the card asks for a link when clicked. */
export interface CardState {
  computerId: string;
  label?: string;
  state: string;
  waiting?: { handoffId: string; reason: string };
}
