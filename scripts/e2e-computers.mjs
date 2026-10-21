#!/usr/bin/env node
// The whole chat path, end to end, on a real Docker computer with a real browser.
//
// What unit tests cannot show: the shared Husk starting from a chat's first
// call, a container computer running the chat tools, Chromium rendering a page,
// the live screen sending real frames, a handoff opened and finished with a
// scoped link, and a real MCP stdio session forwarding its tools to the shared
// Husk. Needs Docker; CI runs it on ubuntu-latest. Run `npm run build` first.
//
//   node scripts/e2e-computers.mjs

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'packages', 'mcp', 'dist', 'bin.js');
const home = mkdtempSync(join(tmpdir(), 'husk-e2e-'));
const env = { ...process.env, HUSK_HOME: home };
delete env.HUSK_DAEMON;
delete env.HUSK_TOKEN;

const steps = [];
function check(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) throw new Error(`failed: ${name}${detail ? ` -- ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let daemon;
let rec;
const created = [];
const textOf = (result) => (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function api(method, path, body, token = rec.token) {
  const res = await fetch(`${rec.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(600_000),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.arrayBuffer() };
}

async function tool(id, name, args = {}) {
  const r = await api('POST', `/v1/computers/${id}/tools/${name}`, { args });
  if (r.status !== 200) throw new Error(`${name} answered ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** A minimal MCP client over a child's stdio. */
function mcpSession(args) {
  const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  let next = 1;
  const request = (method, params) =>
    new Promise((resolveMsg, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 900_000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolveMsg(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  return { child, request, notify };
}

try {
  // 1. The shared Husk, as a chat's first call starts it.
  daemon = spawn(process.execPath, [bin, '--daemon'], { env, stdio: 'inherit' });
  for (let i = 0; i < 120 && !rec; i++) {
    await sleep(250);
    const file = join(home, 'daemon.json');
    if (existsSync(file)) rec = JSON.parse(readFileSync(file, 'utf8'));
  }
  check('the shared Husk starts and writes daemon.json', Boolean(rec?.token), rec?.url);
  check('the console page loads without the token', (await fetch(`${rec.url}/`)).status === 200);
  check('the API refuses a request without the token', (await fetch(`${rec.url}/v1/computers`)).status === 401);

  // 2. A Docker computer with a browser.
  const made = await api('POST', '/v1/computers', { name: 'e2e', provider: 'docker', flavor: 'full' });
  check('a docker computer is created', made.status === 201, JSON.stringify(made.body).slice(0, 300));
  const id = made.body.id;
  created.push(id);

  // 3. Chat tools through the shared route.
  const uname = textOf(await tool(id, 'shell', { command: 'uname -sr' }));
  check('shell runs in Linux', /Linux/.test(uname), uname.trim());
  await tool(id, 'write_file', { path: '/work/hello.txt', content: 'from the e2e\n' });
  check('write_file then read_file', textOf(await tool(id, 'read_file', { path: '/work/hello.txt' })).includes('from the e2e'));
  const goto = await tool(id, 'browser_goto', { url: 'https://example.com' });
  check('the browser renders a page', !goto.isError && /Example Domain/i.test(textOf(goto)), textOf(goto).slice(0, 200));
  const snap = await tool(id, 'browser_snapshot');
  check('a snapshot lists the page', !snap.isError && /Example Domain/i.test(textOf(snap)), `${snap.isError ? 'error: ' : ''}${textOf(snap).slice(0, 400)}`);

  // 4. The live screen sends real frames.
  const frame = await new Promise((resolveFrame, reject) => {
    const ws = new WebSocket(`${rec.url.replace('http', 'ws')}/v1/computers/${id}/screen?token=${rec.token}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('no frame in 60s'));
    }, 60_000);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'frame') {
        clearTimeout(timer);
        ws.close();
        resolveFrame(msg);
      }
    };
    ws.onerror = () => reject(new Error('screen socket failed'));
  });
  check('the live screen sends a frame', frame.data.length > 1000 && frame.width > 0, `${frame.width}x${frame.height}, ${frame.data.length} base64 chars`);

  // 5. The timeline saw every call, and kept the URL but not typed text.
  const activity = (await api('GET', `/v1/computers/${id}/activity`)).body.entries;
  const gotoEntry = activity.find((e) => e.tool === 'browser_goto');
  check('the activity timeline has the calls', activity.length >= 5 && gotoEntry?.summary === 'https://example.com', `${activity.length} entries`);

  // 6. A handoff, opened and finished with a scoped link.
  const opened = await api('POST', `/v1/computers/${id}/handoffs`, { reason: 'e2e: press done' });
  check('a handoff opens with a scoped token', opened.status === 201 && Boolean(opened.body.token));
  const link = opened.body.token;
  const scoped = await api('GET', '/v1/scoped/computer', undefined, link);
  check('the link sees its computer and handoff', scoped.body.handoff?.handoffId === opened.body.handoffId);
  const screen = await api('GET', `/v1/handoffs/${opened.body.handoffId}/screen`, undefined, link);
  check('the link gets the screen', screen.status === 200 && screen.type.includes('image/jpeg'));
  check('the link cannot list computers', (await api('GET', '/v1/computers', undefined, link)).status === 401);
  const held = await tool(id, 'shell', { command: 'echo should-not-run' });
  check('tools are refused while the person holds it', held.isError === true && /has the computer/.test(textOf(held)));
  const done = await api('POST', `/v1/handoffs/${opened.body.handoffId}/done`, undefined, link);
  check('done with the link ends it', done.body.outcome === 'done');
  check('tools run again after done', !(await tool(id, 'shell', { command: 'echo back' })).isError);

  // 7. A real MCP session forwards its tools to the shared Husk.
  const mcp = mcpSession(['--provider', 'docker', '--flavor', 'base']);
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'husk-e2e', version: '0' } });
  check('an MCP client connects over stdio', init.result?.serverInfo?.name === 'husk');
  mcp.notify('notifications/initialized');
  const call = await mcp.request('tools/call', { name: 'shell', arguments: { computer: 'new', command: 'echo hello-from-a-chat' } });
  const callText = textOf(call.result ?? {});
  check('a chat tool call works', /hello-from-a-chat/.test(callText), callText.slice(0, 200));
  const overview = (await api('GET', '/v1/overview')).body;
  const chatComputer = overview.computers.find((c) => c.id !== id && c.spec?.labels?.['husk.via'] === 'mcp');
  if (chatComputer) created.push(chatComputer.id);
  check('the shared Husk saw the chat call', overview.activity?.[chatComputer?.id]?.via === 'mcp', JSON.stringify(overview.activity?.[chatComputer?.id]));
  mcp.child.stdin.end();
  await sleep(1000);

  console.log(`\n${steps.length} checks passed`);
} catch (err) {
  console.error(`\n${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  for (const id of created) await api('DELETE', `/v1/computers/${id}?confirm=${id}`).catch(() => undefined);
  daemon?.kill();
  rmSync(home, { recursive: true, force: true });
}
