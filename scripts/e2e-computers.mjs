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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
let mcp;
const created = [];

async function cleanup() {
  mcp?.child.kill();
  for (const id of created) await api('DELETE', `/v1/computers/${id}?confirm=${id}`).catch(() => undefined);
  daemon?.kill();
  rmSync(home, { recursive: true, force: true });
}
process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)));
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

async function walkConsole(id, name) {
  const { chromium } = await import('playwright-core');
  const shots = process.env.E2E_SHOTS ?? join(root, 'e2e-shots');
  mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.on('pageerror', (err) => errors.push(err.message));
    const shot = (file) => page.screenshot({ path: join(shots, file), fullPage: true });

    // In use a moment ago, with its browser open: Home shows it live.
    await tool(id, 'browser_goto', { url: 'https://example.com' });
    await page.goto(`${rec.url}/#token=${rec.token}&panel=home`);
    const card = page.getByRole('article', { name });
    const live = card.locator(`img[alt="The browser on ${id}, live"]`);
    await live.waitFor({ timeout: 60_000 });
    check('Home shows the browser live on a computer in use', (await live.evaluate((img) => img.naturalWidth)) > 0);
    await shot('01-home-live.png');
    // Live means current: move the computer to a different page while Home is
    // open, and the card's picture must change with it. A kept frame of an
    // earlier page once passed the check above.
    const before = await live.getAttribute('src');
    await tool(id, 'browser_goto', { url: 'http://127.0.0.1:8765/' });
    const moved = await page
      .waitForFunction(([sel, was]) => document.querySelector(sel)?.getAttribute('src') !== was, [`img[alt="The browser on ${id}, live"]`, before], { timeout: 30_000 })
      .then(() => true, () => false);
    check('Home’s live picture follows the page', moved);
    await tool(id, 'browser_goto', { url: 'https://example.com' });

    // Take over without being asked, and the chat's next call waits.
    await card.getByRole('button', { name: 'Take over' }).click();
    await page.getByRole('heading', { name: 'You have this computer' }).waitFor({ timeout: 30_000 });
    await page.locator('.handoff-screen img').waitFor({ timeout: 30_000 });
    check('Take over opens the computer for the person', true);
    await shot('02-taken-over.png');
    let settled = false;
    const started = Date.now();
    const call = tool(id, 'shell', { command: 'echo after-give-back' }).finally(() => {
      settled = true;
    });
    await sleep(3000);
    check('the chat’s call waits while the person holds the computer', !settled);

    // Give back, and the waiting call runs.
    await page.getByRole('button', { name: 'Give back' }).click();
    await page.getByRole('button', { name: 'Yes, hand back to the agent' }).click();
    const result = await call;
    check('Give back lets the waiting call run', !result.isError && /after-give-back/.test(textOf(result)), `${Date.now() - started} ms`);

    // The chat's page: live screen and what the chat did.
    const nav = page.getByRole('navigation', { name: 'Console sections' });
    await nav.getByRole('button', { name: 'Home', exact: true }).click();
    await card.getByRole('button', { name: `Open ${name}` }).click();
    await page.locator(`.chat-screen img[alt="The browser on ${id}, live"]`).waitFor({ timeout: 60_000 });
    await page.locator('.activity-list').getByText('browser_goto').first().waitFor({ timeout: 30_000 });
    check('the Chat page shows the live screen and the activity', true);
    await shot('03-chat.png');

    await nav.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('heading', { name: 'Connect', exact: true }).waitFor({ timeout: 30_000 });
    await sleep(3000);
    await shot('04-connect.png');
    check('the Connect page loads', true);
    check('the console threw no errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(shots, 'failed.png'), fullPage: true }).catch(() => undefined);
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * How fast the browser is, for a PR to quote: the median milliseconds of each
 * browser tool through the shared route, and the frames a second the live
 * screen actually delivers at ?fps=4. The page it watches animates, so a
 * pushed screencast has something to push.
 */
async function measureBrowser(id) {
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const timed = async (name, args, n) => {
    const ms = [];
    for (let i = 0; i < n; i++) {
      const started = performance.now();
      const r = await tool(id, name, args);
      ms.push(performance.now() - started);
      if (r.isError) throw new Error(`${name} failed while measuring: ${textOf(r).slice(0, 300)}`);
    }
    return Math.round(median(ms));
  };

  await tool(id, 'write_file', {
    path: '/work/anim/index.html',
    content:
      '<!doctype html><title>anim</title><h1 id="n">0</h1><button>Go</button>' +
      '<script>let i=0;(function f(){document.getElementById("n").textContent=i++;requestAnimationFrame(f)})()</script>\n',
  });
  await tool(id, 'shell', { command: 'cd /work/anim && (setsid python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &) ; sleep 1' });
  const url = 'http://127.0.0.1:8765/';

  const rows = [
    ['browser_goto', await timed('browser_goto', { url }, 3)],
    ['browser_snapshot', await timed('browser_snapshot', {}, 5)],
    ['browser_wait_for', await timed('browser_wait_for', { text: 'Go' }, 5)],
    ['browser_screenshot', await timed('browser_screenshot', {}, 3)],
  ];
  // The same three steps as one browser_run, where the tool exists.
  const three = [{ do: 'goto', url }, { do: 'wait', text: 'Go' }, { do: 'snapshot' }];
  const probe = await tool(id, 'browser_run', { actions: [{ do: 'snapshot' }] });
  if (!/unknown/.test(textOf(probe))) {
    rows.push(['goto+wait+snapshot', rows[0][1] + rows[2][1] + rows[1][1]]);
    rows.push(['  as one browser_run', await timed('browser_run', { actions: three }, 3)]);
    const run = await tool(id, 'browser_run', { actions: [{ do: 'goto', url }, { do: 'click', role: 'button', name: 'Go' }, { do: 'snapshot' }] });
    check('browser_run clicks by role and name and snapshots, in one call', !run.isError && /button "Go"/.test(textOf(run)), textOf(run).slice(0, 300));
  }

  // Watching is not using: the computer's last-used time must not move while
  // only the screen is open.
  const usedAt = async () => (await api('GET', `/v1/computers/${id}`)).body.lastUsedAt;
  const usedBefore = await usedAt();
  const seconds = 10;
  const frames = await new Promise((resolveCount, reject) => {
    let count = 0;
    let first;
    const give = setTimeout(() => reject(new Error('no frame in 60s')), 60_000 + seconds * 1000);
    const ws = new WebSocket(`${rec.url.replace('http', 'ws')}/v1/computers/${id}/screen?fps=4&token=${rec.token}`);
    ws.onmessage = (ev) => {
      if (JSON.parse(String(ev.data)).type !== 'frame') return;
      // Counted from the first frame, so start-up is not mistaken for frame rate.
      if (first === undefined) {
        first = performance.now();
        setTimeout(() => {
          ws.close();
          clearTimeout(give);
          resolveCount(count);
        }, seconds * 1000);
      } else count++;
    };
    ws.onerror = () => reject(new Error('screen socket failed'));
  });
  const fps = (frames / seconds).toFixed(1);
  const usedAfter = await usedAt();

  const lines = [
    ...rows.map(([name, ms]) => `${name.padEnd(20)} ${String(ms).padStart(6)} ms (median)`),
    `${'screen at ?fps=4'.padEnd(20)} ${fps.padStart(6)} frames/s`,
    `${'watching moved lastUsedAt'.padEnd(20)} ${usedBefore === usedAfter ? 'no' : `yes (${usedBefore} -> ${usedAfter})`}`,
  ];
  console.log(`\n== browser speed ==\n${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Browser speed\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
  }
  check('the browser speed was measured', rows.every(([, ms]) => ms > 0) && frames > 0, `${fps} frames/s`);
  check('watching the screen does not count as using the computer', usedBefore === usedAfter, `${usedBefore} -> ${usedAfter}`);

  // Fast because it is one long-lived driver, not because it quietly fell back.
  // Its own command line holds a backslash and a zero, not a NUL, so it does not count itself.
  const count = String.raw`python3 -c "
import glob
n = 0
for f in glob.glob('/proc/[0-9]*/cmdline'):
    try:
        n += b'driver.py\0--serve' in open(f, 'rb').read()
    except OSError:
        pass
print(n)"`;
  const drivers = textOf(await tool(id, 'shell', { command: count })).trim();
  check('one long-lived driver serves the computer', drivers === '1', `${drivers} running`);
}

/**
 * A browser_script that decides from what the page shows, against
 * example.com, timed like the tools above. It also tries a file:// goto,
 * which the host's policy must refuse and the script must survive.
 */
async function measureScript(id) {
  // Both ways through the same `if`: once for words the page has (its title;
  // example.com rewrites its body text now and then), once for words it lacks.
  const source = [
    'page.goto("https://example.com")',
    'seen = []',
    'for want in ["Example Domain", "No such words on this page"]:',
    '    if want in page.title() or page.has_text(want):',
    '        seen.append("has " + want)',
    '    else:',
    '        seen.append("lacks " + want)',
    'links = [n["name"] for n in page.snapshot() if n["role"] == "link"]',
    'result = {"seen": seen, "links": links}',
    'try:',
    '    page.goto("file:///etc/passwd")',
    '    print("policy let file:// through")',
    'except PageError as e:',
    '    print("refused file://")',
  ].join('\n');
  const ms = [];
  let last;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    last = await tool(id, 'browser_script', { script: source, timeoutSec: 60 });
    ms.push(performance.now() - started);
  }
  const body = textOf(last);
  const median = Math.round([...ms].sort((a, b) => a - b)[1]);
  const line = `${'browser_script'.padEnd(20)} ${String(median).padStart(6)} ms (median; goto + branch + snapshot)`;
  console.log(`${line}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${line}\n\`\`\`\n`);
  }
  let result;
  try {
    result = JSON.parse(body.slice(body.indexOf('result: ') + 'result: '.length));
  } catch {
    result = undefined;
  }
  check(
    'a browser_script branches on what example.com shows',
    !last.isError &&
      JSON.stringify(result?.seen) === JSON.stringify(['has Example Domain', 'lacks No such words on this page']) &&
      result?.links?.length > 0,
    body.slice(0, 400),
  );
  check('a browser_script goto obeys the network policy', /refused file:\/\//.test(body) && !/let file:\/\/ through/.test(body), body.slice(0, 300));
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
  // Unique: the name is the container's, and another `e2e` container would clash.
  const made = await api('POST', '/v1/computers', { name: `e2e-${process.pid}-${Date.now()}`, provider: 'docker', flavor: 'full' });
  check('a docker computer is created', made.status === 201, JSON.stringify(made.body).slice(0, 300));
  const id = made.body.id;
  created.push(id);

  // 3. Chat tools through the shared route.
  const uname = textOf(await tool(id, 'shell', { command: 'uname -sr' }));
  check('shell runs in Linux', /Linux/.test(uname), uname.trim());
  await tool(id, 'write_file', { path: '/work/hello.txt', content: 'from the e2e\n' });
  check('write_file then read_file', textOf(await tool(id, 'read_file', { path: '/work/hello.txt' })).includes('from the e2e'));
  const goto = await tool(id, 'browser_goto', { url: 'https://example.com' });
  check('the browser renders a page', !goto.isError && /Example Domain/i.test(textOf(goto)), JSON.stringify(textOf(goto).slice(0, 200)));
  const snap = await tool(id, 'browser_snapshot');
  // Elements with refs a model can click, e.g. `e24  link "Learn more"`, indented
  // by depth in the compact tree. Not a page heading: example.com changes its
  // text, and the title is not in the tree.
  const refs = textOf(snap).match(/^ *e\d+ {2}\w+/gm) ?? [];
  check('a snapshot lists elements with refs', !snap.isError && refs.length > 0, `${refs.length} elements; ${JSON.stringify(textOf(snap).slice(0, 200))}`);

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
  mcp = mcpSession(['--provider', 'docker', '--flavor', 'base']);
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

  // 8. How fast the browser is, for before-and-after numbers.
  await measureBrowser(id);

  // 8b. A script that makes its own decisions, run inside the computer.
  await measureScript(id);

  // 9. The console in a real browser: Home's live screen, take over at any
  // moment, the chat's call waiting for Give back, the Chat and Connect pages.
  // CI sets E2E_CONSOLE=1 and installs playwright-core (not a dependency) to
  // drive the runner's own Chrome. Screenshots land in E2E_SHOTS.
  if (process.env.E2E_CONSOLE === '1') await walkConsole(id, made.body.name);
  else console.log('skip the console walkthrough (set E2E_CONSOLE=1 with playwright-core installed)');

  console.log(`\n${steps.length} checks passed`);
} catch (err) {
  console.error(`\n${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
