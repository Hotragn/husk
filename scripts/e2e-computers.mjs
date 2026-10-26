#!/usr/bin/env node
// The whole chat path, end to end, on a real Docker computer with a real browser.
//
// What unit tests cannot show: a non-interactive setup in a fresh home, the
// shared Husk it starts, a container computer running the chat tools, Chromium
// rendering a page, the live screen sending real frames, a handoff opened and
// finished with a scoped link, a real MCP stdio session forwarding its tools to
// the shared Husk, and that session going on when the shared Husk dies. Needs
// Docker; CI runs it on ubuntu-latest. Run `npm run build` first.
//
//   node scripts/e2e-computers.mjs

import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'packages', 'mcp', 'dist', 'bin.js');
const cli = join(root, 'packages', 'cli', 'dist', 'bin.js');
const { resolveImage } = await import(pathToFileURL(join(root, 'packages', 'runtime', 'dist', 'index.js')).href);
const home = mkdtempSync(join(tmpdir(), 'husk-e2e-'));

// Just enough of Ollama's API for a bot to get an answer, with no model and no key. Asked
// for "e2e-tool", it runs one command on the computer first and answers with what it printed.
function stubChat(raw) {
  let messages = [];
  try {
    messages = JSON.parse(raw).messages ?? [];
  } catch {
    // not JSON: a plain answer
  }
  const asked = messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join(' ');
  const printed = messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
  const message =
    /e2e-tool/.test(asked) && !printed
      ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'shell', arguments: { command: 'echo bot-ran' } } }] }
      : { role: 'assistant', content: printed ? `Done: ${printed.slice(0, 300)}` : 'Hello from the stub model.' };
  return { model: 'qwen2.5:7b', message, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 6 };
}
const ollama = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk)).on('end', () => {
    const answer = { '/api/tags': { models: [{ name: 'qwen2.5:7b', model: 'qwen2.5:7b' }] }, '/api/show': { capabilities: ['completion', 'tools'] } }[req.url] ?? (req.url === '/api/chat' ? stubChat(raw) : undefined);
    res.writeHead(answer ? 200 : 404, { 'content-type': req.url === '/api/chat' ? 'application/x-ndjson' : 'application/json' });
    res.end(answer ? `${JSON.stringify(answer)}\n` : '');
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));

const env = { ...process.env, HUSK_HOME: home, OLLAMA_HOST: `http://127.0.0.1:${ollama.address().port}` };
delete env.HUSK_DAEMON;
delete env.HUSK_TOKEN;

// A stand-in for the person's own `claude -p` (J5-c). It writes down how it was
// started, starts the MCP server the config Husk gave it names, runs one command
// on the computer through it, and answers as Claude Code's stream-json would.
writeFileSync(
  join(home, 'claude.mjs'),
  String.raw`import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
writeFileSync(join(process.env.HUSK_HOME, 'claude-argv.json'), JSON.stringify(argv));
const husk = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.husk;
const server = spawn(husk.command, husk.args, { env: { ...process.env, ...husk.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let buffer = '';
let next = 1;
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) waiting.get(JSON.parse(line).id)?.(JSON.parse(line));
  }
});
const send = (msg) => server.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const request = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
const say = (line) => process.stdout.write(JSON.stringify(line) + '\n');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '0' } });
send({ method: 'notifications/initialized' });
say({ type: 'system', subtype: 'init', session_id: 'a-fork', mcp_servers: [{ name: 'husk', status: 'connected' }] });
const call = { type: 'tool_use', id: 'tu1', name: 'mcp__husk__shell', input: { command: 'cat /work/marker; echo from-the-bot' } };
say({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [call] } });
const answer = (await request('tools/call', { name: 'shell', arguments: call.input })).result ?? {};
const text = (answer.content ?? []).map((c) => c.text ?? '').join('\n');
say({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: text, is_error: answer.isError === true }] } });
say({ type: 'result', subtype: 'success', is_error: false, result: prompt + '\n' + text, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
server.stdin.end();
`,
);
env.HUSK_CLAUDE_CLI = join(home, 'claude.mjs');
// Where the shared Husk looks for Codex's sessions (J5-d): this run's own folder.
env.CODEX_HOME = join(home, 'codex');

const steps = [];
function check(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) throw new Error(`failed: ${name}${detail ? ` -- ${detail}` : ''}`);
}

/**
 * For a step that needs a third-party site, which is there for the pictures:
 * said, never failing the run. A site being slow or down is not a Husk bug.
 */
function note(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'warn'} ${name}${detail ? ` -- ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rec;
let mcp;
/** The `husk` entry setup wrote into the chat app: how that app starts Husk. */
let appEntry;
const created = [];

/** A running process's record in the home -- the shared Husk's, the job host's -- or undefined. */
function readRecord(file) {
  try {
    return JSON.parse(readFileSync(join(home, file), 'utf8'));
  } catch {
    return undefined;
  }
}
const readDaemon = () => readRecord('daemon.json');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function cleanup() {
  mcp?.child.kill();
  ollama.close();
  // A job host left by a failed run: it would otherwise wait for a bot that is never coming.
  const jobs = readRecord('jobs.json');
  if (jobs && alive(jobs.pid)) process.kill(jobs.pid);
  // As the owner, so a run that failed while it held a computer still tidies it away.
  for (const id of created) await api('DELETE', `/v1/computers/${id}?confirm=${id}`, undefined, rec.token, { 'x-husk-as': 'person' }).catch(() => undefined);
  // Setup started the shared Husk detached, and a chat may have started it again: ask it to stop.
  if (rec) await api('POST', '/v1/shutdown').catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
}
process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)));
const textOf = (result) => (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function api(method, path, body, token = rec.token, headers = {}) {
  const res = await fetch(`${rec.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
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

/**
 * A minimal MCP client over a child's stdio: this build with `args`, or a chat
 * app's own `launch` entry. `answer` replies to the server's own requests, as
 * an app answers its "Done?" prompt; any other request is refused.
 */
function mcpSession(args, launch = { command: process.execPath, args: [bin] }, { env: own = env, answer = () => undefined } = {}) {
  const child = spawn(launch.command, [...launch.args, ...args], { env: { ...own, ...(launch.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method !== undefined) {
        if (msg.id === undefined) continue;
        const result = answer(msg);
        const reply = result === undefined ? { error: { code: -32601, message: `${msg.method} is not answered here` } } : { result };
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply })}\n`);
      } else if (msg.id !== undefined && waiting.has(msg.id)) {
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

/** A small project the "chat" writes and tests on its computer, so the pictures show real work. */
const PROJECT = {
  'package.json': `${JSON.stringify({ name: 'slugify-demo', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  // The computer's root is read-only, so npm keeps its cache and logs in /tmp, and stays quiet.
  '.npmrc': 'cache=/tmp/.npm\nupdate-notifier=false\nfund=false\n',
  'README.md': '# slugify-demo\n\nTurns titles into URL slugs. Written and tested by a chat on its Husk computer.\n',
  'src/slugify.js': String.raw`/** "Hello, World!" -> "hello-world" */
export function slugify(title) {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`,
  'test/slugify.test.js': String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('turns spaces and punctuation into single dashes', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
});

test('drops accents', () => {
  assert.equal(slugify('Crème brûlée'), 'creme-brulee');
});

test('trims dashes at either end', () => {
  assert.equal(slugify('  -Husk-  '), 'husk');
});

test('keeps digits', () => {
  assert.equal(slugify('Top 10 tips for 2026'), 'top-10-tips-for-2026');
});
`,
};
/**
 * A page served from inside the computer, for every check that asserts on what
 * a page says. Four e2e failures on 10-21 and one on 10-22 were example.com
 * rewriting its own text, not Husk. Third-party sites stay only where they make
 * the pictures real, and a failure there is a note, not a FAIL.
 */
const FIXTURE_PORT = 8766;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}/`;
const FIXTURE_HTML = '<!doctype html><html><head><title>Husk fixture</title></head><body>' +
  '<h1>Husk fixture page</h1><p>Served from inside the computer, so its words never change.</p>' +
  '<a href="/a">First link</a> <a href="/b">Second link</a> <button>Press</button></body></html>';

/** Start the fixture server inside the computer. A second start finds the port taken and the first one serving. */
async function serveFixture(id) {
  await tool(id, 'write_file', { path: '/work/fixture/index.html', content: FIXTURE_HTML });
  await tool(id, 'shell', { command: `cd /work/fixture && (setsid python3 -m http.server ${FIXTURE_PORT} --bind 127.0.0.1 >/dev/null 2>&1 &) ; sleep 1` });
}

const REPO_PAGE = 'https://github.com/Hotragn/husk';
const WIKI_PAGE = 'https://en.wikipedia.org/wiki/Personal_computer';

/** What a chat does on its computer: write a project, run its tests, look things up. */
async function stageProject(id) {
  await tool(id, 'shell', { command: 'mkdir -p /work/slugify-demo/src /work/slugify-demo/test' });
  for (const [path, content] of Object.entries(PROJECT)) await tool(id, 'write_file', { path: `/work/slugify-demo/${path}`, content });
  const run = textOf(await tool(id, 'shell', { command: 'cd /work/slugify-demo && npm test 2>&1 | tail -12' }));
  check('the chat’s project tests pass on the computer', /pass 4/.test(run) && /fail 0/.test(run), run.replace(/\s+/g, ' ').slice(-120));
  const repo = await tool(id, 'browser_goto', { url: REPO_PAGE });
  note('the computer’s browser opens a real site', !repo.isError, REPO_PAGE);
}

/**
 * Film `action` as a GIF: a screenshot of `area` (a locator, or the page)
 * a few times a second while it runs, joined by ffmpeg. False where ffmpeg
 * is missing; the walk goes on either way.
 */
async function film(page, file, action, { area, fps = 6 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'husk-film-'));
  let frames = 0;
  let filming = true;
  const loop = (async () => {
    while (filming) {
      const t = Date.now();
      try {
        await (area ?? page).screenshot({ path: join(dir, `f${String(frames).padStart(4, '0')}.png`) });
        frames++;
      } catch {
        // a frame mid-navigation; the next one lands
      }
      await sleep(Math.max(0, 1000 / fps - (Date.now() - t)));
    }
  })();
  try {
    await action();
    await sleep(800);
  } finally {
    filming = false;
    await loop;
  }
  const out = join(process.env.E2E_SHOTS ?? join(root, 'e2e-shots'), file);
  const made = frames > 1 && gif(join(dir, 'f%04d.png'), out, fps, ['-framerate', String(fps)]);
  rmSync(dir, { recursive: true, force: true });
  return made;
}

/** A GIF from frames or a video, at its own size, with a palette so text stays crisp. */
function gif(input, out, fps, inputArgs = []) {
  const r = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', ...inputArgs, '-i', input,
    '-vf', `fps=${fps},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
    out,
  ]);
  return r.status === 0;
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
    const shot = (file, on = page) => on.screenshot({ path: join(shots, file), fullPage: true });
    const screen = page.locator(`img[alt="The browser on ${id}, live"]`);

    // The chat's real work first: a project, its tests, Husk's own page in the browser.
    await stageProject(id);
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

    // A real page with a real search box, the cursor in it, as a chat leaves it before it needs the person.
    await tool(id, 'browser_goto', { url: WIKI_PAGE });
    const tree = textOf(await tool(id, 'browser_snapshot'));
    const search = /\b(e\d+)\s+(?:searchbox|combobox|textbox)\s+"[^"]*search/i.exec(tree)?.[1];
    if (search) await tool(id, 'browser_click', { ref: search });
    else console.log('  (no search box in the snapshot; the take-over types into the page as it is)');
    await live.waitFor({ timeout: 60_000 });

    // Take over without being asked, and type into the real page: filmed.
    const filmed = await film(page, 'take-over.gif', async () => {
      await card.getByRole('button', { name: 'Take over', exact: true }).click();
      await page.getByText('You’re in control').waitFor({ timeout: 30_000 });
      await page.locator('.screen-held img').waitFor({ timeout: 30_000 });
      await page.locator('input[aria-label="Type into the page"]').focus();
      await page.keyboard.type('Husk computer', { delay: 140 });
      await sleep(2500);
    });
    check('Take over opens the chat page with the screen held', true, filmed ? 'filmed take-over.gif' : 'no ffmpeg, no GIF');
    await shot('02-taken-over.png');

    // A click on the screen goes to the page, mapped from the frame, and focuses the keyboard.
    const box = await screen.boundingBox();
    const clicked = page.waitForResponse((r) => r.url().endsWith('/input') && r.request().method() === 'POST');
    // The page's left margin: nothing there to follow, so what the person typed stays on the page.
    await page.mouse.click(box.x + box.width * 0.012, box.y + box.height * 0.6);
    check('a click on the held screen reaches the page', (await clicked).status() === 204);
    check('the click focuses the keyboard on the page', (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Type into the page');

    let settled = false;
    const started = Date.now();
    const call = tool(id, 'shell', { command: 'echo after-give-back' }).finally(() => {
      settled = true;
    });
    await sleep(3000);
    check('the chat’s call waits while the person holds the computer', !settled);

    // Give back, beside the screen, and the waiting call runs.
    await page.getByRole('button', { name: 'Give back' }).click();
    const result = await call;
    check('Give back lets the waiting call run', !result.isError && /after-give-back/.test(textOf(result)), `${Date.now() - started} ms`);
    if (search) {
      const typed = textOf(await tool(id, 'browser_snapshot'));
      check('what the person typed reached the real page', /Husk computer/.test(typed));
    }

    // The chat's page, free again: the live screen, what the chat did, and Take over on a click.
    await page.getByText('The chat is in control').waitFor({ timeout: 30_000 });
    await page.locator('.activity-list').getByText('after-give-back').first().waitFor({ timeout: 30_000 });
    await screen.waitFor({ timeout: 60_000 });
    check('the Chat page shows the live screen and the activity', true);
    const gaps = await page.$$eval('.activity-list li', (rows) =>
      rows.map((li) => li.querySelector('.activity-meta').getBoundingClientRect().left - li.querySelector('strong').getBoundingClientRect().right),
    );
    check('no tool name runs into its timing', gaps.length > 0 && gaps.every((g) => g >= 8), gaps.map(Math.round).join(','));
    await shot('03-chat.png');
    await page.getByRole('button', { name: 'Take over this computer' }).click();
    await page.getByRole('group', { name: 'Take over' }).waitFor({ timeout: 10_000 });
    check('clicking the free screen offers Take over', true);
    await page.keyboard.press('Escape');

    const nav = page.getByRole('navigation', { name: 'Console sections' });
    await nav.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('heading', { name: 'Connect', exact: true }).waitFor({ timeout: 30_000 });
    await sleep(3000);
    await shot('04-connect.png');
    check('the Connect page loads', true);

    // The computer's own tools, as a person sees them: its browser, its files, its terminal.
    await nav.getByRole('button', { name: 'Home', exact: true }).click();
    await card.getByRole('button', { name: 'Browser', exact: true }).click();
    await page.getByRole('tab', { name: /Rendered/ }).click();
    // GitHub for the picture; the fixture inside the computer if GitHub is slow or down, so
    // the check is about the panel, not about a third-party site.
    const openInPanel = async (url, timeout) => {
      await page.locator('#browse-url').fill(url);
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      return page.locator('#browser-view img').first().waitFor({ timeout }).then(() => true, () => false);
    };
    let rendered = await openInPanel('github.com/Hotragn/husk', 90_000);
    note('the Browser panel opens a real site', rendered, 'github.com/Hotragn/husk');
    if (!rendered) rendered = await openInPanel(FIXTURE, 60_000);
    await sleep(2500);
    await shot('07-browser.png');
    check('the Browser panel shows the computer’s page, rendered in its Chromium', rendered);

    await nav.getByRole('button', { name: 'Home', exact: true }).click();
    await card.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'slugify-demo/', exact: true }).click();
    await page.getByRole('button', { name: 'src/', exact: true }).click();
    await page.getByRole('button', { name: 'slugify.js', exact: true }).click();
    await page.getByText('export function slugify').first().waitFor({ timeout: 30_000 });
    await sleep(500);
    await shot('08-files.png');
    check('the Files panel walks the chat’s project and opens its code', true);

    await nav.getByRole('button', { name: 'Home', exact: true }).click();
    await card.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.locator('.xterm-rows').getByText(/one command per line/).waitFor({ timeout: 30_000 });
    await page.locator('.xterm-helper-textarea').focus();
    const tested = await film(
      page,
      'terminal-tests.gif',
      async () => {
        await page.keyboard.type('cd /work/slugify-demo && npm test', { delay: 60 });
        await page.keyboard.press('Enter');
        await page.locator('.xterm-rows').getByText(/pass 4/).last().waitFor({ timeout: 60_000 });
        await sleep(1500);
      },
      { area: page.locator('.term-frame') },
    );
    await shot('09-terminal.png');
    check('the Terminal panel runs the chat’s tests on the computer', true, tested ? 'filmed terminal-tests.gif' : 'no ffmpeg, no GIF');

    // One picture of the computer's browser, files and terminal together, for the PRs.
    const tile = (file, caption) =>
      `<figure><img src="data:image/png;base64,${readFileSync(join(shots, file)).toString('base64')}"><figcaption>${caption}</figcaption></figure>`;
    const board = await browser.newPage({ viewport: { width: 2100, height: 700 } });
    await board.setContent(
      `<style>body{margin:0;padding:28px;background:#0a0a0c;font:600 18px Inter,system-ui,sans-serif;color:#f4f4f5;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}` +
        `figure{margin:0}img{width:100%;border-radius:12px;border:1px solid #24242a;display:block}figcaption{margin-top:12px;color:#b4b4bc}</style>` +
        tile('07-browser.png', 'Browser: GitHub in its own Chromium') +
        tile('08-files.png', 'Files: the chat’s project, its code open') +
        tile('09-terminal.png', 'Terminal: the project’s tests, run on the computer'),
    );
    await board.screenshot({ path: join(shots, '10-computer-browser-files-terminal.png'), fullPage: true });
    await board.close();

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await nav.getByRole('button', { name: 'Home', exact: true }).click();
    await live.waitFor({ timeout: 60_000 });
    await shot('05-home-light.png');
    check('the light theme applies', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');

    // What a chat app without cards links to (Claude Code): its own computer, and Take over.
    const { body } = await api('POST', `/v1/computers/${id}/link`);
    const linked = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    linked.on('pageerror', (err) => errors.push(err.message));
    await linked.goto(`${rec.url}/#computer=${encodeURIComponent(id)}&token=${body.token}`);
    await linked.getByRole('button', { name: 'Take over', exact: true }).click();
    await linked.getByText('You have this computer').waitFor({ timeout: 30_000 });
    await linked.locator('.screen-held img').waitFor({ timeout: 30_000 });
    check('a chat’s link takes the computer over', true);
    await shot('06-link-taken-over.png', linked);
    await linked.getByRole('button', { name: 'Give back' }).click();
    await linked.getByText('Handed back to the chat').waitFor({ timeout: 30_000 });
    await linked.getByText('Computer running').waitFor({ timeout: 10_000 });
    check('the link gives the computer back and keeps working', true);
    const after = await tool(id, 'shell', { command: 'echo after-link' });
    check('the chat has its computer again after the link gives it back', !after.isError && /after-link/.test(textOf(after)));

    check('the console threw no errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    for (const [i, p] of browser.contexts().flatMap((c) => c.pages()).entries()) {
      await p.screenshot({ path: join(shots, `failed-${i}.png`), fullPage: true }).catch(() => undefined);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * The real desktop app on this Husk (HUSK_DESKTOP_SMOKE=live), walked on a
 * real chat's computer while the chat keeps browsing, and filmed from the
 * screen where the tools for it are there.
 */
async function walkDesktop(id) {
  const electron = join(root, 'apps', 'desktop', 'node_modules', '.bin', 'electron');
  const shots = process.env.E2E_SHOTS ?? join(root, 'e2e-shots');
  // Its own screen, so the walk can be filmed as a person would see it: a
  // compositor so the corner and the notch are truly transparent, over the
  // person's own work. Without these tools it runs under xvfb-run, unfilmed.
  const display = ':99';
  const helpers = [];
  const has = (bin) => spawnSync('which', [bin]).status === 0;
  const filmable = ['Xvfb', 'xcompmgr', 'ffmpeg'].every(has);
  if (filmable) {
    helpers.push(spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' }));
    await sleep(1500);
    helpers.push(spawn('xcompmgr', ['-d', display], { stdio: 'ignore' }));
    await sleep(500);
    // The person's own work fills the screen behind Husk, as on a real desktop: an editor, in the runner's Chrome.
    if (has('google-chrome')) {
      const profile = mkdtempSync(join(tmpdir(), 'husk-screen-'));
      const flags = ['--no-first-run', '--no-default-browser-check', '--password-store=basic', `--user-data-dir=${profile}`];
      helpers.push(spawn('google-chrome', [...flags, '--window-position=0,0', '--window-size=1280,800', '--app=https://vscode.dev'], { env: { ...env, DISPLAY: display }, stdio: 'ignore' }));
      await sleep(8000);
    }
  }
  const app = filmable
    ? spawn(electron, [join(root, 'apps', 'desktop')], {
        env: { ...env, DISPLAY: display, HUSK_DESKTOP_SMOKE: 'live', HUSK_DESKTOP_SHOTS: shots, ELECTRON_DISABLE_SANDBOX: '1' },
        stdio: ['ignore', 'pipe', 'inherit'],
      })
    : spawn('xvfb-run', ['-a', electron, join(root, 'apps', 'desktop')], {
        env: { ...env, HUSK_DESKTOP_SMOKE: 'live', HUSK_DESKTOP_SHOTS: shots, ELECTRON_DISABLE_SANDBOX: '1' },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
  let out = '';
  app.stdout.on('data', (chunk) => {
    out += chunk;
  });
  let done = false;
  const exited = new Promise((resolveExit) =>
    app.on('exit', (code) => {
      done = true;
      resolveExit(code);
    }),
  );
  const killer = setTimeout(() => app.kill('SIGKILL'), 240_000);
  const video = join(tmpdir(), `husk-desktop-${process.pid}.mp4`);
  let recorder;
  try {
    for (let i = 0; i < 480 && !out.includes('SMOKE live ready'); i++) await sleep(250);
    check('the desktop app attaches to the shared Husk', out.includes('SMOKE live ready'));
    if (filmable) {
      // The right of the screen, at its own size: the notch at the top centre, the window and the corner at the bottom right.
      const grab = ['-f', 'x11grab', '-draw_mouse', '0', '-framerate', '10', '-video_size', '880x800', '-i', `${display}.0+400,0`];
      recorder = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...grab, '-codec:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video], {
        stdio: ['pipe', 'ignore', 'inherit'],
      });
    }
    // The chat goes on working while the person looks: real pages, one after another.
    const pages = [REPO_PAGE, WIKI_PAGE, `${REPO_PAGE}/issues`];
    for (let i = 0; !done && i < 12; i++) {
      await tool(id, 'browser_goto', { url: pages[i % pages.length] }).catch(() => undefined);
      for (let t = 0; t < 24 && !done; t++) await sleep(250);
    }
    const code = await exited;
    const lines = out.split(/\r?\n/).filter((l) => l.startsWith('SMOKE ok') || l.startsWith('SMOKE FAIL'));
    for (const line of lines) console.log(`  desktop: ${line.slice('SMOKE '.length)}`);
    const failed = lines.filter((l) => l.startsWith('SMOKE FAIL'));
    check('the desktop app walks a real chat’s computer', code === 0 && failed.length === 0 && lines.length > 0, failed.join(' | ') || `${lines.length} checks, exit ${code}`);
  } finally {
    clearTimeout(killer);
    app.kill();
    if (recorder) {
      recorder.stdin.end('q');
      await new Promise((r) => recorder.on('exit', r));
      const made = existsSync(video) && gif(video, join(shots, 'desktop.gif'), 6);
      console.log(made ? '  desktop: filmed desktop.gif from the real screen' : '  desktop: no GIF of the screen');
      rmSync(video, { force: true });
    }
    for (const h of helpers) h.kill();
  }
}

/**
 * Honest clicks (J3-a), on pages served from inside the computer: a click on
 * something covered or disabled, or a role and name that match two buttons,
 * is refused, saying why; force still clicks; a plain click lands and says so.
 */
async function checkHonestClicks(id) {
  const pages = {
    'overlay.html':
      '<!doctype html><title>overlay</title><button onclick="document.title=\'button\'">Behind</button>' +
      '<div onclick="document.title=\'backdrop\'" style="position:fixed;inset:0;background:rgba(0,0,0,.3)">Backdrop</div>',
    'disabled.html': '<!doctype html><title>disabled</title><button disabled onclick="document.title=\'clicked\'">Submit</button>',
    'dupes.html':
      '<!doctype html><title>dupes</title><button onclick="document.title=\'first\'">OK</button> ' +
      '<button onclick="document.title=\'second\'">OK</button>',
  };
  for (const [name, html] of Object.entries(pages)) await tool(id, 'write_file', { path: `/work/fixture/${name}`, content: html });
  const title = async () => /result: "([^"]*)"/.exec(textOf(await tool(id, 'browser_script', { script: 'result = page.title()' })))?.[1];
  const refOf = async (label) => new RegExp(`^ *(e\\d+) {2}button "${label}"`, 'm').exec(textOf(await tool(id, 'browser_snapshot')))?.[1];

  await tool(id, 'browser_goto', { url: `${FIXTURE}overlay.html` });
  const behind = await refOf('Behind');
  const covered = await tool(id, 'browser_click', { ref: behind });
  check('a click on a covered button is refused, saying what covers it', covered.isError === true && /covered/.test(textOf(covered)) && /Backdrop/.test(textOf(covered)), textOf(covered).slice(0, 200));
  const forced = await tool(id, 'browser_click', { ref: behind, force: true });
  check('force still clicks, and lands where the click lands', !forced.isError && /without the checks/.test(textOf(forced)) && (await title()) === 'backdrop', textOf(forced).slice(0, 160));

  await tool(id, 'browser_goto', { url: `${FIXTURE}disabled.html` });
  const disabled = await tool(id, 'browser_click', { ref: await refOf('Submit') });
  check('a click on a disabled button is refused', disabled.isError === true && /disabled/.test(textOf(disabled)), textOf(disabled).slice(0, 160));

  await tool(id, 'browser_goto', { url: `${FIXTURE}dupes.html` });
  const twice = await tool(id, 'browser_run', { actions: [{ do: 'click', role: 'button', name: 'OK' }] });
  check('a role and name that match two buttons is refused', twice.isError === true && /2 elements have role 'button' and name 'OK'/.test(textOf(twice)), textOf(twice).slice(0, 200));
  const first = await tool(id, 'browser_run', { actions: [{ do: 'click', role: 'button', name: 'OK', force: true }] });
  check('force clicks the first of them', !first.isError && (await title()) === 'first', textOf(first).slice(0, 160));

  await tool(id, 'browser_goto', { url: FIXTURE });
  const press = await tool(id, 'browser_click', { ref: await refOf('Press') });
  check('a click on a plain button lands, and says so', !press.isError && /landed on it/.test(textOf(press)), textOf(press).slice(0, 160));
}

/**
 * Refs that expire (J3-b): a ref from an earlier page is refused, rather than
 * resolved to whatever has its id on the new one. Typing into a field inside a
 * frame is shown once frames have refs of their own (J3-c).
 */
async function checkFreshRefs(id) {
  const refOf = (snap, role, label) => new RegExp(`^ *(e\\d+) {2}${role} "${label}"`, 'm').exec(textOf(snap))?.[1];
  await tool(id, 'browser_goto', { url: FIXTURE });
  const old = refOf(await tool(id, 'browser_snapshot'), 'button', 'Press');
  // A new document, with a snapshot of its own.
  await tool(id, 'browser_goto', { url: `${FIXTURE}overlay.html` });
  const stale = await tool(id, 'browser_click', { ref: old });
  check('a ref from an earlier page is refused, not clicked', stale.isError === true && /from an earlier page/.test(textOf(stale)), textOf(stale).slice(0, 200));
}

/**
 * Frames (J3-c): a same-origin and a cross-site frame are read into the
 * snapshot under their <iframe>, with refs that name the frame; typing, Enter
 * and a click in either reach the field, and a frame that loads another page
 * on its own takes its refs with it. localhost is another site from 127.0.0.1,
 * so Chromium runs that frame in a process of its own.
 */
async function checkFrames(id) {
  const inner =
    '<!doctype html><title>inner</title>' +
    "<form onsubmit=\"event.preventDefault(); parent.postMessage(location.hostname + ' submitted:' + this.q.value, '*')\">" +
    "<label>Name <input name=\"q\" onchange=\"parent.postMessage(location.hostname + ' changed:' + this.value, '*')\"></label></form> " +
    "<button onclick=\"parent.postMessage(location.hostname + ' pressed', '*')\">Go</button> " +
    '<a href="/index.html">Elsewhere</a>';
  const pages = {
    'frames.html':
      '<!doctype html><title>frames</title>' +
      "<script>addEventListener('message', (e) => { document.title = String(e.data); });</script>" +
      '<iframe title="same" src="/inner.html" style="width:420px;height:120px"></iframe>' +
      `<iframe title="cross" src="http://localhost:${FIXTURE_PORT}/inner.html" style="width:420px;height:120px"></iframe>`,
    'inner.html': inner,
  };
  for (const [name, content] of Object.entries(pages)) await tool(id, 'write_file', { path: `/work/fixture/${name}`, content });
  const title = async () => /result: "([^"]*)"/.exec(textOf(await tool(id, 'browser_script', { script: 'result = page.title()' })))?.[1];

  await tool(id, 'browser_goto', { url: `${FIXTURE}frames.html` });
  const snap = textOf(await tool(id, 'browser_snapshot'));
  // A frame's refs follow its <iframe>'s line.
  const inFrame = (name, role, label) => new RegExp(`Iframe "${name}"\\n(?:.*\\n)*? *(f\\d+e\\d+) {2}${role} "${label}"`).exec(snap)?.[1];
  const sameName = inFrame('same', 'textbox', 'Name');
  const crossName = inFrame('cross', 'textbox', 'Name');
  const crossGo = inFrame('cross', 'button', 'Go');
  const frameOf = (ref) => /^f\d+/.exec(ref ?? '')?.[0];
  check(
    'a snapshot reads a same-origin and a cross-site frame, its refs naming the frame',
    Boolean(sameName && crossName && crossGo) && frameOf(sameName) !== frameOf(crossName),
    snap.slice(0, 600),
  );
  const typed = await tool(id, 'browser_type', { ref: sameName, text: 'abc' });
  check('typing in a same-origin frame reaches its field', !typed.isError && (await title()) === '127.0.0.1 changed:abc', textOf(typed).slice(0, 200));
  const submitted = await tool(id, 'browser_type', { ref: crossName, text: 'xyz', submit: true });
  check('typing and Enter in a cross-site frame submit its form', !submitted.isError && (await title()) === 'localhost submitted:xyz', textOf(submitted).slice(0, 200));
  const pressed = await tool(id, 'browser_click', { ref: crossGo });
  check('a click in a cross-site frame lands on its button', !pressed.isError && (await title()) === 'localhost pressed', textOf(pressed).slice(0, 200));
  await tool(id, 'browser_click', { ref: inFrame('cross', 'link', 'Elsewhere') });
  const stale = await tool(id, 'browser_type', { ref: crossName, text: 'late' });
  check('a frame that loads another page takes its refs with it', stale.isError === true && /from an earlier page/.test(textOf(stale)), textOf(stale).slice(0, 200));
}

/**
 * A hard page, end to end (the J3 gate). A shop whose consent banner, in a
 * cross-site frame, veils the page; whose order button is disabled until a size
 * is chosen; that confirms before it orders; that downloads an invoice, opens
 * tracking in a new tab, and has a support link that sends the page to an
 * internal address. The chat's own tools do each step, and each refusal says
 * why: what a model meets on a real site, all on one page.
 */
async function checkHardPageJourney(id) {
  const pages = {
    'shop.html':
      '<!doctype html><title>shop</title>' +
      '<style>#veil{position:fixed;inset:0;background:rgba(0,0,0,.3)} #consent{position:fixed;left:20px;bottom:20px;width:420px;height:90px;border:0;z-index:2;background:#fff}</style>' +
      '<h1>Husk shop</h1>' +
      "<button onclick=\"document.getElementById('order').hidden = false\">Buy</button>" +
      '<div id="order" hidden>' +
      "<label>Size <select onchange=\"document.getElementById('place').disabled = !this.value\"><option value=\"\">Choose</option><option value=\"m\">M</option><option value=\"l\">L</option></select></label> " +
      "<button id=\"place\" disabled onclick=\"if (confirm('Place the order?')) { document.getElementById('done').hidden = false; document.getElementById('placed').textContent = 'Order placed' }\">Place order</button>" +
      '<p id="placed"></p>' +
      '<div id="done" hidden><a href="/journey/invoice.txt" download>Invoice</a> <a href="/journey/track.html" target="_blank">Track it</a> <a href="/journey/support.html">Support</a></div>' +
      '</div>' +
      '<div id="veil"></div>' +
      `<iframe id="consent" title="consent" src="http://localhost:${FIXTURE_PORT}/journey/consent.html"></iframe>` +
      "<script>addEventListener('message', (e) => { if (e.data === 'accepted') { document.getElementById('veil').remove(); document.getElementById('consent').remove(); } });</script>",
    'consent.html': "<!doctype html><title>consent</title><p>We use cookies.</p><button onclick=\"parent.postMessage('accepted', '*')\">Accept</button>",
    'track.html': '<!doctype html><title>track</title><h1>Tracking</h1><p>Your order ships tomorrow.</p>',
    'support.html': "<!doctype html><title>support</title><script>location.href = 'http://10.255.255.1/support'</script>",
    'invoice.txt': 'invoice 42\n',
  };
  for (const [name, content] of Object.entries(pages)) await tool(id, 'write_file', { path: `/work/fixture/journey/${name}`, content });
  const refOf = (snap, role, label) => new RegExp(`^ *((?:f\\d+)?e\\d+) {2}${role} "${label}"`, 'm').exec(snap)?.[1];

  await tool(id, 'browser_goto', { url: `${FIXTURE}journey/shop.html` });
  const shopTab = /^\* (\S+)/m.exec(textOf(await tool(id, 'browser_tabs')))?.[1];
  const snap = textOf(await tool(id, 'browser_snapshot'));
  const veiled = await tool(id, 'browser_click', { ref: refOf(snap, 'button', 'Buy') });
  check('J3 gate: a click under the consent veil is refused, naming the veil', veiled.isError === true && /covered: .*<div#veil>/.test(textOf(veiled)), textOf(veiled).slice(0, 200));
  const accepted = await tool(id, 'browser_click', { ref: refOf(snap, 'button', 'Accept') });
  check('J3 gate: the consent in a cross-site frame is accepted through its frame ref', !accepted.isError && /^Clicked f\d+e\d+/.test(textOf(accepted)), textOf(accepted).slice(0, 200));
  const bought = textOf(await tool(id, 'browser_click', { ref: refOf(snap, 'button', 'Buy') }));
  const off = await tool(id, 'browser_click', { ref: refOf(bought, 'button', 'Place order') });
  check('J3 gate: the order button is refused while it is disabled', off.isError === true && /is disabled/.test(textOf(off)), textOf(off).slice(0, 200));
  await tool(id, 'browser_select', { ref: refOf(bought, 'combobox', 'Size'), value: 'M' });
  const placed = await tool(id, 'browser_click', {
    ref: refOf(bought, 'button', 'Place order'),
    dialog: 'accept',
    waitFor: { text: 'Order placed', timeoutSec: 5 },
  });
  check(
    'J3 gate: the confirm is accepted and said, and the wait sees the order placed',
    /confirm dialog: "Place the order\?"\. Husk accepted it/.test(textOf(placed)) && /Then waited for text "Order placed": it appeared/.test(textOf(placed)),
    textOf(placed).slice(0, 300),
  );
  const done = textOf(placed);
  const invoiceRef = refOf(done, 'link', 'Invoice');
  const invoice = await tool(id, 'browser_click', { ref: invoiceRef });
  const file = textOf(await tool(id, 'read_file', { path: '/work/downloads/invoice.txt' }));
  check('J3 gate: the invoice downloads into /work/downloads', /downloaded invoice\.txt/.test(textOf(invoice)) && /invoice 42/.test(file), textOf(invoice).slice(0, 200));
  const tracked = textOf(await tool(id, 'browser_click', { ref: refOf(done, 'link', 'Track it') }));
  const tab = /switchTo "([^"]+)"/.exec(tracked)?.[1];
  const tracking = tab ? textOf(await tool(id, 'browser_tabs', { switchTo: tab })) : '';
  check('J3 gate: tracking opens in a new tab, named so one call goes there', /heading "Tracking"/.test(tracking), tracked.slice(0, 200));
  if (shopTab) await tool(id, 'browser_tabs', { switchTo: shopTab });
  const support = await tool(id, 'browser_click', { ref: refOf(done, 'link', 'Support') });
  check(
    'J3 gate: a link that sends the page to an internal address is stopped',
    /network policy stopped the page from loading http:\/\/10\.255\.255\.1\/support/.test(textOf(support)),
    textOf(support).slice(0, 300),
  );
  const stale = await tool(id, 'browser_click', { ref: invoiceRef });
  check('J3 gate: a ref from the shop is refused once the page has left it', stale.isError === true && /from an earlier page/.test(textOf(stale)), textOf(stale).slice(0, 200));
}

/** The Playwright MCP the benchmark measures Husk against: pinned, so two runs measure the same thing. */
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83';

/**
 * Husk against Playwright MCP on the same computer and the same Chromium
 * (J3-f). The same tasks on the same fixture pages, each tool set driven by a
 * scripted plan that uses its own tools as economically as it can and still
 * does the task: not a model, which would need an API key that CI does not
 * have. Playwright MCP runs inside the computer and launches the same Chromium
 * binary itself, as it does by default (attached over --cdp-endpoint instead,
 * it never hears of a download), so Husk's driver neither answers its dialogs
 * nor polices its loads. The tab task runs last: both tool sets leave the tabs
 * it opens. Measured: whether each plan did the task, its calls, its wall time
 * (median and worst of RUNS) and the bytes it read back. Published to the job
 * summary as measured; a measurement, so it never fails the run.
 */
async function benchmarkAgainstPlaywright(id, container) {
  const RUNS = 5;
  const BENCH = `${FIXTURE}bench/`;
  const say = (text) => `const h = document.createElement('h1'); h.textContent = ${text}; document.body.replaceChildren(h)`;
  const pages = {
    'read.html': '<!doctype html><title>read</title><h1>Quarterly report</h1><p>Revenue grew 12% this quarter.</p>',
    'form.html': `<!doctype html><title>form</title><form onsubmit="event.preventDefault(); ${say("'Signed in as ' + this.email.value")}"><label>Email <input name="email"></label> <button>Sign in</button></form>`,
    'confirm.html': `<!doctype html><title>confirm</title><button onclick="if (confirm('Delete it?')) { ${say("'Deleted'")} }">Delete</button>`,
    'toast.html':
      "<!doctype html><title>toast</title><button onclick=\"const t = document.createElement('div'); t.textContent = 'Saved!'; document.body.append(t); setTimeout(() => t.remove(), 150)\">Save</button>",
    'frame.html':
      `<!doctype html><title>frame</title><iframe title="profile" src="http://localhost:${FIXTURE_PORT}/bench/inner.html" style="width:420px;height:100px"></iframe><h1 id="hello"></h1>` +
      "<script>addEventListener('message', (e) => { document.getElementById('hello').textContent = String(e.data); })</script>",
    'inner.html': "<!doctype html><title>inner</title><label>Name <input oninput=\"parent.postMessage('Hello, ' + this.value, '*')\"></label>",
    'tab.html': '<!doctype html><title>tab</title><a href="/bench/second.html" target="_blank">Open</a>',
    'second.html': '<!doctype html><title>second</title><h1>Second page</h1>',
    'files.html': '<!doctype html><title>files</title><a href="/bench/report.txt" download>Report</a>',
    'report.txt': 'quarterly numbers\n',
  };
  for (const [name, content] of Object.entries(pages)) await tool(id, 'write_file', { path: `/work/fixture/bench/${name}`, content });

  // Each plan gets a call function that counts; it returns whether the task is done.
  const husk = {
    read: async (t) => /Quarterly report/.test((await t('browser_goto', { url: `${BENCH}read.html` })).text),
    form: async (t) =>
      /heading "Signed in as ada@example\.com"/.test(
        (
          await t('browser_run', {
            actions: [
              { do: 'goto', url: `${BENCH}form.html` },
              { do: 'fill', role: 'textbox', name: 'Email', text: 'ada@example.com' },
              { do: 'click', role: 'button', name: 'Sign in', waitFor: { text: 'Signed in as' } },
              { do: 'snapshot' },
            ],
          })
        ).text,
      ),
    confirm: async (t) =>
      /it appeared after/.test(
        (await t('browser_run', { actions: [{ do: 'goto', url: `${BENCH}confirm.html` }, { do: 'click', role: 'button', name: 'Delete', dialog: 'accept', waitFor: { text: 'Deleted' } }] })).text,
      ),
    toast: async (t) =>
      /it appeared after/.test(
        (await t('browser_run', { actions: [{ do: 'goto', url: `${BENCH}toast.html` }, { do: 'click', role: 'button', name: 'Save', waitFor: { text: 'Saved!' } }] })).text,
      ),
    frame: async (t) => {
      const snap = (await t('browser_run', { actions: [{ do: 'goto', url: `${BENCH}frame.html` }, { do: 'snapshot' }] })).text;
      const ref = /(f\d+e\d+) {2}textbox "Name"/.exec(snap)?.[1];
      return Boolean(ref) && /it appeared after/.test((await t('browser_type', { ref, text: 'Ada', waitFor: { text: 'Hello, Ada' } })).text);
    },
    download: async (t) =>
      /downloaded report\.txt/.test((await t('browser_run', { actions: [{ do: 'goto', url: `${BENCH}files.html` }, { do: 'click', role: 'link', name: 'Report' }] })).text),
    tab: async (t) => {
      const clicked = (await t('browser_run', { actions: [{ do: 'goto', url: `${BENCH}tab.html` }, { do: 'click', role: 'link', name: 'Open' }] })).text;
      const tab = /switchTo "([^"]+)"/.exec(clicked)?.[1];
      return Boolean(tab) && /heading "Second page"/.test((await t('browser_tabs', { switchTo: tab })).text);
    },
  };
  const playwright = {
    read: async (t) => {
      await t('browser_navigate', { url: `${BENCH}read.html` });
      return /Quarterly report/.test((await t('browser_snapshot', {})).text);
    },
    form: async (t) => {
      await t('browser_navigate', { url: `${BENCH}form.html` });
      await t('browser_type', { element: 'Email field', target: 'input[name=email]', text: 'ada@example.com', submit: true });
      return /Signed in as ada@example\.com/.test((await t('browser_snapshot', {})).text);
    },
    confirm: async (t) => {
      await t('browser_navigate', { url: `${BENCH}confirm.html` });
      await t('browser_click', { element: 'Delete button', target: 'button' });
      await t('browser_handle_dialog', { accept: true });
      return /Deleted/.test((await t('browser_snapshot', {})).text);
    },
    toast: async (t) => {
      await t('browser_navigate', { url: `${BENCH}toast.html` });
      // Gone 150 ms after the click, before a wait could start: watched from before the click instead.
      await t('browser_evaluate', {
        function: "() => { window.seen = false; new MutationObserver(() => { window.seen ||= document.body.innerText.includes('Saved!'); }).observe(document.body, { childList: true, subtree: true }); }",
      });
      await t('browser_click', { element: 'Save button', target: 'button' });
      return /\btrue\b/.test((await t('browser_evaluate', { function: '() => window.seen' })).text);
    },
    frame: async (t) => {
      await t('browser_navigate', { url: `${BENCH}frame.html` });
      const ref = /textbox "Name" \[ref=(\w+)\]/.exec((await t('browser_snapshot', {})).text)?.[1];
      if (!ref) return false;
      await t('browser_type', { element: 'Name field', target: ref, text: 'Ada' });
      return /Hello, Ada/.test((await t('browser_snapshot', {})).text);
    },
    download: async (t) => {
      await t('browser_navigate', { url: `${BENCH}files.html` });
      const done = /Downloaded file report\.txt to/;
      // A download still going when the click returns is said finished in the next reply.
      return done.test((await t('browser_click', { element: 'Report link', target: 'a' })).text) || done.test((await t('browser_snapshot', {})).text);
    },
    tab: async (t) => {
      await t('browser_navigate', { url: `${BENCH}tab.html` });
      const clicked = (await t('browser_click', { element: 'Open link', target: 'a' })).text;
      const index = /- (\d+): \[[^\]]*\]\(http:\/\/127\.0\.0\.1:\d+\/bench\/second\.html\)/.exec(clicked)?.[1];
      if (index === undefined) return false;
      await t('browser_tabs', { action: 'select', index: Number(index) });
      return /Second page/.test((await t('browser_snapshot', {})).text);
    },
  };

  const measure = async (plans, call) => {
    const out = {};
    for (const [task, plan] of Object.entries(plans)) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        let calls = 0;
        let bytes = 0;
        // Why a task was not done: the first call that failed, else the last reply.
        let why = '';
        let last = '';
        const t = async (name, args) => {
          calls++;
          const r = await call(name, args);
          bytes += r.text.length;
          last = `${name}: ${r.text}`;
          if (r.isError && !why) why = last;
          return r;
        };
        const started = performance.now();
        let ok = false;
        try {
          ok = await plan(t);
        } catch (err) {
          why ||= `threw: ${err.message}`;
        }
        runs.push({ ok, calls, bytes, ms: Math.round(performance.now() - started), ...(ok ? {} : { why: (why || last).replace(/\s+/g, ' ').slice(0, 300) }) });
      }
      out[task] = runs;
    }
    return out;
  };
  const sum = (runs) => {
    const sorted = (xs) => [...xs].sort((a, b) => a - b);
    const ms = sorted(runs.map((r) => r.ms));
    return {
      done: runs.filter((r) => r.ok).length,
      calls: sorted(runs.map((r) => r.calls))[Math.floor(runs.length / 2)],
      median: ms[Math.floor(ms.length / 2)],
      worst: ms.at(-1),
      bytes: sorted(runs.map((r) => r.bytes))[Math.floor(runs.length / 2)],
    };
  };

  const was = /^\* (\S+)/m.exec(textOf(await tool(id, 'browser_tabs')))?.[1];
  const huskRuns = await measure(husk, async (name, args) => {
    const r = await tool(id, name, args);
    return { text: textOf(r), isError: r.isError === true };
  });
  if (was) await tool(id, 'browser_tabs', { switchTo: was });

  // Playwright MCP launches its own Chromium, as it does by default: the same binary, in the same computer.
  let pwRuns;
  let pwWhy = '';
  const binary = /already installed: (\S+)/.exec(textOf(await tool(id, 'browser_status')))?.[1];
  let pw;
  try {
    if (!binary) throw new Error('no Chromium binary for Playwright MCP to launch');
    // The computer's user has no home directory, and Playwright MCP keeps a cache in one: /tmp is its home here.
    pw = mcpSession([], {
      command: 'docker',
      args: [
        'exec', '-i', '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/.npm', '-e', 'npm_config_update_notifier=false', '-w', '/tmp', container,
        'npx', '-y', PLAYWRIGHT_MCP, '--executable-path', binary, '--headless', '--isolated', '--no-sandbox', '--output-dir', '/tmp/pwmcp',
      ],
    });
    await pw.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'husk-e2e', version: '0' } });
    pw.notify('notifications/initialized');
    pwRuns = await measure(playwright, async (name, args) => {
      const r = (await pw.request('tools/call', { name, arguments: args })).result ?? {};
      return { text: textOf(r), isError: r.isError === true };
    });
  } catch (err) {
    pwWhy = err.message;
  } finally {
    pw?.child.kill();
    // Playwright MCP and the Chromium it launched (its profile is playwright_chromiumdev_profile-*), should either outlive the session.
    await tool(id, 'shell', { command: "pkill -f -- 'playwrigh[t]' || true" }).catch(() => undefined);
  }

  const cell = (s) => `${s.done}/${RUNS} done, ${s.calls} call${s.calls === 1 ? '' : 's'}, ${s.median} ms (worst ${s.worst}), ${s.bytes} bytes`;
  const lines = [`${'task'.padEnd(10)} ${'Husk'.padEnd(62)} Playwright MCP`];
  const rows = [];
  for (const task of Object.keys(husk)) {
    const h = sum(huskRuns[task]);
    const p = pwRuns ? sum(pwRuns[task]) : undefined;
    lines.push(`${task.padEnd(10)} ${cell(h).padEnd(62)} ${p ? cell(p) : 'not measured'}`);
    rows.push({ task, husk: h, playwright: p ?? null });
  }
  // What a task that was not done last said, once per tool set and task.
  const notDone = [];
  for (const [who, runs] of [['Husk', huskRuns], ['Playwright MCP', pwRuns ?? {}]]) {
    for (const [task, rs] of Object.entries(runs)) {
      const failed = rs.find((r) => !r.ok);
      if (failed) notDone.push(`${who}, ${task}: ${failed.why}`);
    }
  }
  console.log(
    `\nHusk against ${PLAYWRIGHT_MCP}, same computer, same Chromium, scripted plans, ${RUNS} runs each\n${lines.join('\n')}` +
      `${pwWhy ? `\nPlaywright MCP not measured: ${pwWhy}` : ''}${notDone.length ? `\nnot done, and why:\n${notDone.map((l) => `  ${l}`).join('\n')}` : ''}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    const md = (s) => (s ? `${s.done}/${RUNS} | ${s.calls} | ${s.median} / ${s.worst} | ${s.bytes}` : 'not measured | | |');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Husk against Playwright MCP\n\nThe same tasks on the same computer and the same Chromium binary (${PLAYWRIGHT_MCP} over --cdp-endpoint, on a second Chromium), each driven by a scripted plan that uses its own tools as economically as it can -- not a model. ${RUNS} runs each; ms is median / worst; bytes is what the plan read back.\n\n` +
        '| Task | Husk done | calls | ms | bytes | Playwright MCP done | calls | ms | bytes |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' +
        rows.map((r) => `| ${r.task} | ${md(r.husk)} | ${md(r.playwright)} |`).join('\n') +
        `${pwWhy ? `\n\nPlaywright MCP was not measured: ${pwWhy}` : ''}` +
        `${notDone.length ? `\n\nNot done, and why (the first such run):\n\n${notDone.map((l) => `- ${l.replace(/\|/g, '\\|')}`).join('\n')}` : ''}\n`,
    );
  }
  if (process.env.E2E_SHOTS) {
    mkdirSync(process.env.E2E_SHOTS, { recursive: true });
    writeFileSync(join(process.env.E2E_SHOTS, 'benchmark.json'), `${JSON.stringify({ against: PLAYWRIGHT_MCP, runs: RUNS, rows, husk: huskRuns, playwright: pwRuns ?? null, notMeasured: pwWhy || null }, null, 2)}\n`);
  }
}

/**
 * Every browser tool on a real Chromium (J3-g): the ones no other check here
 * asserts -- status, select, upload, hover, wait_for, scroll, navigate, tabs
 * and screenshot -- each do what they say on a fixture page, read back from
 * the page itself.
 */
async function checkEveryBrowserTool(id) {
  const later = "setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Later!'; document.body.append(p); }, 400)";
  const scrolled =
    'addEventListener("scroll", () => { if (!document.getElementById("seen")) { const p = document.createElement("p"); p.id = "seen"; p.textContent = "Scrolled down"; document.body.prepend(p); } })';
  await tool(id, 'write_file', {
    path: '/work/fixture/tools.html',
    content:
      `<!doctype html><title>tools</title><script>${scrolled}</script>` +
      `<label>Size <select onchange="document.title = 'size:' + this.value"><option value="s">Small</option><option value="l">Large</option></select></label> ` +
      `<label>Attachment <input type="file" onchange="document.title = 'file:' + this.files[0].name"></label> ` +
      `<button onmouseover="document.getElementById('menu').hidden = false">Account</button><div id="menu" hidden><a href="#settings">Settings</a></div> ` +
      `<button onclick="${later}">Later</button>` +
      '<div style="height:3000px"></div><p>The end</p>',
  });
  await tool(id, 'write_file', { path: '/work/fixture/attachment.txt', content: 'for the upload\n' });
  const refOf = (snap, role, label) => new RegExp(`^ *((?:f\\d+)?e\\d+) {2}${role} "${label}"`, 'm').exec(snap)?.[1];
  const title = async () => /result: "([^"]*)"/.exec(textOf(await tool(id, 'browser_script', { script: 'result = page.title()' })))?.[1];

  const status = textOf(await tool(id, 'browser_status'));
  check('browser_status says a browser is installed, so nothing is downloaded', /already installed/.test(status), status.slice(0, 200));

  await tool(id, 'browser_goto', { url: `${FIXTURE}tools.html` });
  const snap = textOf(await tool(id, 'browser_snapshot'));
  const selected = await tool(id, 'browser_select', { ref: refOf(snap, 'combobox', 'Size'), value: 'Large' });
  check('browser_select chooses an option, and the page hears it', /selected "Large"/.test(textOf(selected)) && (await title()) === 'size:l', textOf(selected).slice(0, 200));

  const uploaded = await tool(id, 'browser_upload', { ref: refOf(snap, 'button', 'Attachment'), files: ['/work/fixture/attachment.txt'] });
  check('browser_upload attaches a file from the computer, and the page sees it', /attached 1 file/.test(textOf(uploaded)) && (await title()) === 'file:attachment.txt', textOf(uploaded).slice(0, 200));

  const hovered = textOf(await tool(id, 'browser_hover', { ref: refOf(snap, 'button', 'Account') }));
  check('browser_hover reveals what only shows under the pointer', /link "Settings"/.test(hovered), hovered.slice(0, 300));

  await tool(id, 'browser_click', { ref: refOf(snap, 'button', 'Later') });
  const waited = textOf(await tool(id, 'browser_wait_for', { text: 'Later!', timeoutSec: 5 }));
  check('browser_wait_for waits for text that comes later', /appeared after \d+ ms/.test(waited), waited.slice(0, 200));

  const scrolledTo = await tool(id, 'browser_scroll', { ref: refOf(snap, 'StaticText', 'The end') });
  const seen = textOf(await tool(id, 'browser_wait_for', { text: 'Scrolled down', timeoutSec: 5 }));
  check('browser_scroll brings an element into view, and the page scrolls', !scrolledTo.isError && /appeared after \d+ ms/.test(seen), seen.slice(0, 200));

  await tool(id, 'browser_goto', { url: FIXTURE });
  const back = textOf(await tool(id, 'browser_navigate', { how: 'back' }));
  const forward = textOf(await tool(id, 'browser_navigate', { how: 'forward' }));
  const reloaded = textOf(await tool(id, 'browser_navigate', { how: 'reload' }));
  check(
    'browser_navigate goes back, forward and reloads',
    back.startsWith(`now at ${FIXTURE}tools.html`) && forward.startsWith(`now at ${FIXTURE}`) && !forward.includes('tools.html') && reloaded.startsWith(`now at ${FIXTURE}`),
    `${back.slice(0, 80)} | ${forward.slice(0, 80)} | ${reloaded.slice(0, 80)}`,
  );

  const was = /^\* (\S+)/m.exec(textOf(await tool(id, 'browser_tabs')))?.[1];
  const opened = textOf(await tool(id, 'browser_tabs', { open: `${FIXTURE}tools.html` }));
  const tab = /opened and switched to (\S+)/.exec(opened)?.[1];
  const listed = textOf(await tool(id, 'browser_tabs'));
  const returned = textOf(await tool(id, 'browser_tabs', { switchTo: was }));
  check(
    'browser_tabs lists, opens and switches tabs',
    Boolean(was && tab) && new RegExp(`^\\* ${tab} `, 'm').test(listed) && returned.startsWith(`switched to ${FIXTURE}`),
    `${opened.slice(0, 80)} | ${returned.slice(0, 80)}`,
  );

  const shot = await tool(id, 'browser_screenshot', { path: '/work/shot.png' });
  const magic = textOf(await tool(id, 'shell', { command: 'head -c 8 /work/shot.png | od -An -tx1' }));
  check(
    'browser_screenshot writes a PNG into the computer and shows it',
    /wrote a viewport screenshot to \/work\/shot\.png/.test(textOf(shot)) && (shot.content ?? []).some((c) => c.type === 'image') && /89 50 4e 47/.test(magic),
    `${textOf(shot).slice(0, 120)} | ${magic.trim()}`,
  );
}

/**
 * Fewer turns (J3-f): every browser result says where the page is, a snapshot
 * can be of one part of the page, and a click can carry its wait, watched from
 * just before it, so a toast that comes and goes as the click settles is caught.
 */
async function checkFewerTurns(id) {
  const toast = "const t = document.createElement('div'); t.className = 'toast'; t.textContent = 'Saved!'; document.body.append(t); setTimeout(() => t.remove(), 150)";
  await tool(id, 'write_file', {
    path: '/work/fixture/toast.html',
    content:
      '<!doctype html><title>toast</title>' +
      '<form aria-label="Sign in"><label>Email <input></label> <button type="button">Go</button></form> ' +
      `<button onclick="${toast}">Save</button>`,
  });
  const refOf = (snap, role, label) => new RegExp(`^ *((?:f\\d+)?e\\d+) {2}${role} "${label}"`, 'm').exec(snap)?.[1];
  await tool(id, 'browser_goto', { url: `${FIXTURE}toast.html` });
  const snap = textOf(await tool(id, 'browser_snapshot'));
  check('a browser result says where the page is', snap.startsWith('now at http://127.0.0.1:8766/toast.html -- "toast", loaded'), snap.slice(0, 200));
  const part = textOf(await tool(id, 'browser_snapshot', { ref: refOf(snap, 'form', 'Sign in') }));
  check('a snapshot of one part of the page lists only that part', /textbox "Email"/.test(part) && !/button "Save"/.test(part), part.slice(0, 300));
  const saved = await tool(id, 'browser_click', { ref: refOf(snap, 'button', 'Save'), waitFor: { selector: '.toast', timeoutSec: 5 } });
  check(
    "a click's wait, armed before it, catches a toast that came and went",
    !saved.isError && /Then waited for selector \.toast: it appeared after \d+ ms/.test(textOf(saved)),
    textOf(saved).slice(0, 300),
  );
}

/**
 * The network policy below the tool (J3-e): what a page loads by itself goes by
 * the policy too. An HTTP redirect, a script redirect, a frame, a pop-up, and a
 * link inside a cross-site frame, each to an internal address, are stopped
 * before anything is sent, and the result says so. 10.255.255.1 is internal on
 * every provider and routes nowhere, so nothing is ever contacted.
 */
async function checkPolicyBelowTheTool(id) {
  const INTERNAL = 'http://10.255.255.1/secret';
  const pages = {
    'jsredirect.html': `<!doctype html><title>js</title><script>location.href = '${INTERNAL}'</script>`,
    'badframe.html': `<!doctype html><title>badframe</title><iframe title="bad" src="${INTERNAL}"></iframe>`,
    'popup.html': `<!doctype html><title>popup</title><button onclick="window.open('${INTERNAL}')">Open</button>`,
    'framelink.html': `<!doctype html><title>framelink</title><iframe title="cross" src="http://localhost:${FIXTURE_PORT}/secretlink.html" style="width:420px;height:120px"></iframe>`,
    'secretlink.html': `<!doctype html><title>secretlink</title><a href="${INTERNAL}">Secret</a>`,
  };
  for (const [name, content] of Object.entries(pages)) await tool(id, 'write_file', { path: `/work/fixture/${name}`, content });
  // An HTTP redirect needs a server that answers 302: a few lines of Python, on the next port.
  const redirectPort = FIXTURE_PORT + 1;
  await tool(id, 'write_file', {
    path: '/work/redirect.py',
    content: [
      'import http.server',
      'class Redirect(http.server.BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      '        self.send_response(302)',
      `        self.send_header('Location', '${INTERNAL}')`,
      '        self.end_headers()',
      '    def log_message(self, *args):',
      '        pass',
      `http.server.HTTPServer(('127.0.0.1', ${redirectPort}), Redirect).serve_forever()`,
      '',
    ].join('\n'),
  });
  await tool(id, 'shell', { command: '(setsid python3 /work/redirect.py >/dev/null 2>&1 &) ; sleep 1' });
  const stopped = (r) => /network policy (refused|stopped the page from loading) http:\/\/10\.255\.255\.1\/secret/.test(textOf(r));
  const refOf = (snap, role, label) => new RegExp(`^ *((?:f\\d+)?e\\d+) {2}${role} "${label}"`, 'm').exec(textOf(snap))?.[1];

  const redirected = await tool(id, 'browser_goto', { url: `http://127.0.0.1:${redirectPort}/` });
  check('an HTTP redirect to an internal address is refused, saying where it led', redirected.isError === true && stopped(redirected), textOf(redirected).slice(0, 300));
  const scripted = await tool(id, 'browser_goto', { url: `${FIXTURE}jsredirect.html` });
  check('a page that sends itself to an internal address is stopped, and the result says so', stopped(scripted), textOf(scripted).slice(0, 300));
  const framed = await tool(id, 'browser_goto', { url: `${FIXTURE}badframe.html` });
  check('a frame from an internal address is stopped, and the page still loads', !framed.isError && stopped(framed), textOf(framed).slice(0, 300));
  await tool(id, 'browser_goto', { url: `${FIXTURE}popup.html` });
  const popup = await tool(id, 'browser_click', { ref: refOf(await tool(id, 'browser_snapshot'), 'button', 'Open') });
  check('a pop-up to an internal address is stopped', stopped(popup), textOf(popup).slice(0, 300));
  await tool(id, 'browser_goto', { url: `${FIXTURE}framelink.html` });
  const followed = await tool(id, 'browser_click', { ref: refOf(await tool(id, 'browser_snapshot'), 'link', 'Secret') });
  check('a link inside a cross-site frame to an internal address is stopped', stopped(followed), textOf(followed).slice(0, 300));
}

/**
 * The browser recovers (J3-d): Chromium killed inside the computer, the call
 * that finds it gone says so, and the next one starts it again.
 */
async function checkBrowserRecovers(id) {
  await tool(id, 'browser_goto', { url: FIXTURE });
  // por[t]: the pattern matches Chromium's command line and not the shell's that runs it.
  await tool(id, 'shell', { command: "pkill -KILL -f -- '--remote-debugging-por[t]'; sleep 1" });
  const gone = await tool(id, 'browser_snapshot');
  check('a call that finds Chromium dead says so, and that the next call starts it again', gone.isError === true && /starts it again/.test(textOf(gone)), textOf(gone).slice(0, 300));
  const back = await tool(id, 'browser_goto', { url: FIXTURE });
  const page = textOf(await tool(id, 'browser_snapshot'));
  check('the next call starts Chromium again', !back.isError && /Husk fixture page/.test(page), `${textOf(back).slice(0, 200)} | ${page.slice(0, 200)}`);
}

/**
 * Pages that ask and pages that hand things over (J3-c): an alert is answered
 * and said, a confirm is dismissed unless dialog: "accept", a download lands in
 * /work/downloads, and a link to a new tab says which tab it opened.
 */
async function checkDialogsDownloadsTabs(id) {
  const pages = {
    'dialogs.html':
      '<!doctype html><title>dialogs</title>' +
      '<button onclick="alert(\'Saved!\'); document.title = \'after-alert\'">Save</button> ' +
      '<button onclick="document.title = confirm(\'Delete it?\') ? \'deleted\' : \'kept\'">Delete</button>',
    'files.html': '<!doctype html><title>files</title><a href="/report.txt" download>Report</a> <a href="/index.html" target="_blank">Open in a new tab</a>',
    'report.txt': 'quarterly numbers\n',
  };
  for (const [name, content] of Object.entries(pages)) await tool(id, 'write_file', { path: `/work/fixture/${name}`, content });
  const title = async () => /result: "([^"]*)"/.exec(textOf(await tool(id, 'browser_script', { script: 'result = page.title()' })))?.[1];
  const refOf = (snap, role, label) => new RegExp(`^ *(e\\d+) {2}${role} "${label}"`, 'm').exec(textOf(snap))?.[1];

  await tool(id, 'browser_goto', { url: `${FIXTURE}dialogs.html` });
  let snap = await tool(id, 'browser_snapshot');
  const saved = await tool(id, 'browser_click', { ref: refOf(snap, 'button', 'Save') });
  check('an alert a click opens is answered and said, and the click goes on', !saved.isError && /showed an alert dialog: "Saved!"/.test(textOf(saved)) && (await title()) === 'after-alert', textOf(saved).slice(0, 200));
  const del = refOf(snap, 'button', 'Delete');
  const kept = await tool(id, 'browser_click', { ref: del });
  check('a confirm is dismissed unless asked, saying how to accept it', /confirm dialog: "Delete it\?"\. Husk dismissed it/.test(textOf(kept)) && (await title()) === 'kept', textOf(kept).slice(0, 200));
  const deleted = await tool(id, 'browser_click', { ref: del, dialog: 'accept' });
  check('dialog: "accept" accepts it', /Husk accepted it/.test(textOf(deleted)) && (await title()) === 'deleted', textOf(deleted).slice(0, 200));

  await tool(id, 'browser_goto', { url: `${FIXTURE}files.html` });
  snap = await tool(id, 'browser_snapshot');
  const got = await tool(id, 'browser_click', { ref: refOf(snap, 'link', 'Report') });
  const file = textOf(await tool(id, 'read_file', { path: '/work/downloads/report.txt' }));
  check('a download lands in /work/downloads, and the click says so', /downloaded report\.txt/.test(textOf(got)) && /quarterly numbers/.test(file), textOf(got).slice(0, 200));
  const opened = await tool(id, 'browser_click', { ref: refOf(snap, 'link', 'Open in a new tab') });
  check('a link to a new tab says which tab it opened', /opened a new tab: http:\/\/127\.0\.0\.1:8766\/index\.html/.test(textOf(opened)), textOf(opened).slice(0, 200));
}

/**
 * A stopped command is gone from the computer, not only from this side: killing
 * the `docker exec` client used to leave it running there while the chat was
 * told it "was killed".
 */
async function checkStops(id) {
  const timedOut = await tool(id, 'shell', { command: 'sleep 307', timeoutSec: 2 });
  check('a timed-out command says it was stopped', /timed out after \d+s and was stopped/.test(textOf(timedOut)), textOf(timedOut).slice(0, 200));
  // Counted from /proc, not with pgrep: the counting shell's own command line
  // names the command too, and not every image ships pgrep.
  const running = (what) => `for d in /proc/[0-9]*; do tr '\\0' ' ' < "$d/cmdline" 2>/dev/null; echo; done | grep -c '^${what}' || true`;
  const left = textOf(await tool(id, 'shell', { command: running('sleep 307') })).trim();
  check('a timed-out command is gone from the computer', left === '0', left);

  // Cancelled by the caller: a chat's tool call (an MCP cancel aborts it), then a
  // plain /exec. Seen running before the cancel, so one that never started cannot
  // pass; the server stops it after the caller has gone, so the count may take a moment.
  const until = async (what, done) => {
    let n = '';
    for (let i = 0; i < 20; i++) {
      n = textOf(await tool(id, 'shell', { command: running(what) })).trim();
      if (done(n)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return n;
  };
  const cancelWhileRunning = async (path, body, what) => {
    const caller = new AbortController();
    const call = fetch(`${rec.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rec.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: caller.signal,
    }).catch(() => undefined);
    const ran = await until(what, (n) => n !== '0');
    caller.abort();
    await call;
    return { ran, left: await until(what, (n) => n === '0') };
  };
  const viaTool = await cancelWhileRunning(`/v1/computers/${id}/tools/shell`, { args: { command: 'sleep 311', timeoutSec: 120 } }, 'sleep 311');
  check('a command the chat cancelled is gone from the computer', viaTool.ran !== '0' && viaTool.left === '0', JSON.stringify(viaTool));
  const viaExec = await cancelWhileRunning(`/v1/computers/${id}/exec`, { cmd: 'sleep 313', timeoutSec: 120 }, 'sleep 313');
  check('a command whose caller left is gone from the computer', viaExec.ran !== '0' && viaExec.left === '0', JSON.stringify(viaExec));
}

/**
 * A person taking over stops the AI where it is. A browser script that would
 * run two minutes is seen running, then cut off part-way; its process is gone
 * from the computer; the chat is told. After Give back, a page action waits
 * until the AI has looked at the page again.
 */
async function checkTakeover(id) {
  const scripts = `n=0; for d in /proc/[0-9]*; do tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -q '^HUSK_SCRIPT=' && n=$((n+1)); done; echo $n`;
  const count = async () => textOf(await tool(id, 'shell', { command: scripts })).trim();
  const call = tool(id, 'browser_script', { script: 'import time\ntime.sleep(120)\nprint("finished")', timeoutSec: 150 });
  let seen = '0';
  for (let i = 0; i < 60 && seen === '0'; i++) {
    await sleep(500);
    seen = await count();
  }
  // What the console and the desktop say a take-over is waiting for.
  const running = (await api('GET', '/v1/overview')).body.running?.[id];
  check('the overview names the call a take-over would wait for', running?.tool === 'browser_script', JSON.stringify(running));
  const started = Date.now();
  // As the console does it: the person takes it, and only the person gives it back.
  const person = { 'x-husk-as': 'person' };
  const taken = await api('POST', `/v1/computers/${id}/takeover`, undefined, rec.token, person);
  const stopped = textOf(await call);
  check(
    'a take-over stops a running browser script, and tells the chat',
    seen !== '0' && taken.status === 201 && /stopped part-way/.test(stopped),
    `${seen} running, stopped in ${Date.now() - started} ms: ${stopped.slice(0, 160)}`,
  );
  await api('POST', `/v1/handoffs/${taken.body.handoffId}/done`, undefined, rec.token, person);
  const left = await count();
  check('the stopped script is gone from the computer', left === '0', left);
  const early = textOf(await tool(id, 'browser_click', { ref: 'e99999' }));
  check('after Give back, a page action waits for a fresh look', /stopped part-way/.test(early), early.slice(0, 160));
  await tool(id, 'browser_snapshot');
  const after = textOf(await tool(id, 'browser_click', { ref: 'e99999' }));
  check('once the AI has looked again, the page action runs', !/stopped part-way/.test(after), after.slice(0, 160));
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
 * A browser_script that decides from what the page shows, against the
 * fixture page, timed like the tools above. It also tries a file:// goto,
 * which the host's policy must refuse and the script must survive.
 */
async function measureScript(id) {
  // Both ways through the same `if`: once for words the fixture has, once for words it lacks.
  const source = [
    `page.goto("${FIXTURE}")`,
    'seen = []',
    'for want in ["Husk fixture", "No such words on this page"]:',
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
    'a browser_script branches on what the fixture page shows',
    !last.isError &&
      JSON.stringify(result?.seen) === JSON.stringify(['has Husk fixture', 'lacks No such words on this page']) &&
      result?.links?.length > 0,
    body.slice(0, 400),
  );
  check('a browser_script goto obeys the network policy', /refused file:\/\//.test(body) && !/let file:\/\/ through/.test(body), body.slice(0, 300));
}

/**
 * The chat setup connected, started the way its app starts it, from the entry
 * setup wrote: a page on the computer setup chose. Then the shared Husk is
 * killed under it, and the chat's next call must start a new one and go on with
 * the same computer, never quietly somewhere else. The chat stays open for
 * checkSignIn; its computer is what this returns.
 */
async function checkRestart() {
  mcp = mcpSession([], appEntry);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'husk-e2e-app', version: '0' } });
  mcp.notify('notifications/initialized');
  const known = new Set((await api('GET', '/v1/overview')).body.computers.map((c) => c.id));
  const hello = textOf((await mcp.request('tools/call', { name: 'shell', arguments: { computer: 'new', command: 'echo from-the-app' } })).result ?? {});
  const mine = (await api('GET', '/v1/overview')).body.computers.find((c) => !known.has(c.id));
  if (mine) created.push(mine.id);
  check('a chat started from the app’s entry gets its computer', /from-the-app/.test(hello) && Boolean(mine), hello.slice(0, 200));
  await serveFixture(mine.id);
  const page = textOf((await mcp.request('tools/call', { name: 'browser_goto', arguments: { computer: mine.id, url: FIXTURE } })).result ?? {});
  check('it opens a page, on the image setup chose', /Husk fixture/.test(page), page.slice(0, 200));

  const old = readDaemon();
  process.kill(old.pid, 'SIGKILL');
  for (let i = 0; i < 40 && (await fetch(`${old.url}/health`).then(() => true, () => false)); i++) await sleep(250);
  const after = await mcp.request('tools/call', { name: 'shell', arguments: { computer: mine.id, command: 'head -c 60 /work/fixture/index.html; echo; echo still-here' } });
  const text = textOf(after.result ?? {});
  check('the chat goes on, with its files, when the shared Husk dies under it', !after.result?.isError && /still-here/.test(text) && /Husk fixture/.test(text), text.slice(0, 300));
  rec = readDaemon();
  check('a new shared Husk took over', Boolean(rec?.token) && rec.pid !== old.pid, `pid ${old.pid} -> ${rec?.pid}`);
  const seen = (await api('GET', '/v1/overview')).body.activity?.[mine.id];
  check('the call went through the new shared Husk, not the chat’s own process', seen?.via === 'mcp' && seen.tool === 'shell', JSON.stringify(seen));
  return mine.id;
}

/**
 * Sign in for me, across a restart (the J2 gate): the chat hands its computer
 * to the person, who types into the page; the shared Husk restarts mid-login;
 * the hold is still there and the AI is refused; the person gives it back, and
 * the chat goes on.
 */
async function checkSignIn(computerId) {
  const hidden = (s) => s.replace(/token=[0-9a-f]+/g, 'token=<redacted>');
  const page = textOf((await mcp.request('tools/call', { name: 'browser_goto', arguments: { computer: computerId, url: FIXTURE } })).result ?? {});
  check('the chat opens the page to sign in on', /Husk fixture/.test(page), page.slice(0, 120));

  // 1. hand_off, then the person types in the viewer.
  const handed = textOf((await mcp.request('tools/call', { name: 'hand_off', arguments: { computer: computerId, reason: 'e2e: sign in to the fixture' } })).result ?? {});
  const link = /#handoff=(hnd_[a-z0-9]+)&token=([0-9a-f]+)/i.exec(handed);
  check('the chat hands the computer to the person, with a link', Boolean(link), hidden(handed).slice(0, 200));
  const [, handoffId, token] = link;
  const typed = await api('POST', `/v1/handoffs/${handoffId}/input`, { type: 'text', text: 'e2e-sign-in' }, token);
  check('the person types into the page through the link', typed.status === 204, String(typed.status));

  // 2. The shared Husk restarts mid-login: killed, and started again by the chat waiting on it.
  const old = readDaemon();
  process.kill(old.pid, 'SIGKILL');
  let fresh = old;
  for (let i = 0; i < 160 && fresh?.pid === old.pid; i++) {
    await sleep(250);
    fresh = readDaemon() ?? old;
  }
  const up = fresh.pid !== old.pid && (await fetch(`${fresh.url}/health`).then((r) => r.ok, () => false));
  check('the chat starts the shared Husk again while the person signs in', up, `pid ${old.pid} -> ${fresh.pid}`);
  rec = fresh;

  // 3. The hold is still there, and the AI is refused.
  const held = (await api('GET', '/v1/overview')).body.handoffs.find((h) => h.computerId === computerId);
  check('the hold is still there after the restart', held?.handoffId === handoffId, JSON.stringify(held));
  const refused = await tool(computerId, 'shell', { command: 'echo should-not-run' });
  check('the AI is refused while the person has it', refused.isError === true && /has the computer/.test(textOf(refused)), textOf(refused).slice(0, 160));

  // 4. Give back, and the chat goes on.
  const given = await api('POST', `/v1/handoffs/${handoffId}/done`, undefined, rec.token, { 'x-husk-as': 'person' });
  check('the person gives it back', given.status === 200, JSON.stringify(given.body).slice(0, 120));
  let after;
  for (let i = 0; i < 20; i++) {
    after = await mcp.request('tools/call', { name: 'shell', arguments: { computer: computerId, command: 'echo back-to-work' } });
    if (!after.result?.isError) break;
    await sleep(500);
  }
  check('the chat goes on once it is given back', !after.result?.isError && /back-to-work/.test(textOf(after.result ?? {})), textOf(after.result ?? {}).slice(0, 160));
  mcp.child.stdin.end();
}

/**
 * Delete means delete (J4-e): a chat's computer keeps its files and browser
 * profile in a volume for its next computer, and the console's Delete, once
 * the person confirms, takes that volume with it.
 */
/**
 * `packages` on a docker computer, which can install nothing itself: its root
 * is read-only and it holds no capabilities. They are built into an image of
 * its own, FROM the computer's, and it runs that.
 */
async function checkPackages() {
  const made = await api('POST', '/v1/computers', { name: `e2e-pkgs-${process.pid}`, provider: 'docker', packages: ['jq'] });
  check('a docker computer asked for packages is made', made.status === 201, JSON.stringify(made.body).slice(0, 300));
  if (made.status !== 201) return;
  const id = made.body.id;
  created.push(id);
  try {
    const ran = await api('POST', `/v1/computers/${id}/exec`, { cmd: 'jq --version' });
    check(
      'its packages are in it, built into an image of its own',
      /^jq-1\./.test(ran.body?.stdout ?? '') && /^husk-packages:/.test(made.body.image ?? ''),
      `${made.body.image}: ${JSON.stringify(ran.body).slice(0, 200)}`,
    );
  } finally {
    // Gone at once: the desktop app counts the computers in the corner later.
    await api('DELETE', `/v1/computers/${id}?confirm=${id}`, undefined, rec.token, { 'x-husk-as': 'person' }).catch(() => undefined);
  }
}

async function checkDeleteErases(id) {
  const info = (await api('GET', `/v1/computers/${id}`)).body;
  const mounts = spawnSync('docker', ['inspect', '-f', `{{range .Mounts}}{{if eq .Destination "${info.workdir}"}}{{.Name}}{{end}}{{end}}`, info.nativeId], { encoding: 'utf8' });
  const volume = mounts.stdout.trim();
  check('a chat’s computer keeps its files and browser profile in a volume of its own', volume.startsWith('husk-key-'), volume || mounts.stderr);
  const deleted = await api('DELETE', `/v1/computers/${id}?confirm=${id}&erase=true`, undefined, rec.token, { 'x-husk-as': 'person' });
  check('the console’s Delete removes it once the person confirms', deleted.status === 204, String(deleted.status));
  check('and its volume is gone: delete means delete', Boolean(volume) && spawnSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' }).status !== 0, volume);
}

/**
 * A bot's trigger, in a job host of its own (J5-a): the shared Husk chats
 * start mounts no trigger. Saving a bot with one starts the job host, the
 * trigger keeps the shared Husk's address, the job host asks the shared Husk
 * to run the bot, and it leaves once no bot has a trigger.
 */
async function checkJobHost() {
  const spec = { name: 'e2e-bot', model: 'ollama/qwen2.5:7b', persona: 'Answer in one line.', tools: [], triggers: [{ type: 'http', path: '/ask', auth: 'token' }] };
  check('the shared Husk starts with no job host: no bot has a trigger', !readRecord('jobs.json'));
  const saved = await api('POST', '/v1/husks', { spec });
  check('a bot with a trigger is saved', saved.status === 201, JSON.stringify(saved.body).slice(0, 200));
  const jobs = readRecord('jobs.json');
  check('saving it starts the job host, a process of its own', alive(jobs?.pid) && jobs.pid !== rec.pid, `shared Husk ${rec.pid}, job host ${jobs?.pid}`);
  const mounted = (await api('GET', '/v1/triggers')).body.triggers ?? [];
  check('the shared Husk lists the trigger the job host mounted', mounted.some((t) => t.husk === 'e2e-bot' && t.at === '/v1/t/e2e-bot/ask'), JSON.stringify(mounted));
  check('the trigger keeps the shared Husk’s token', (await fetch(`${rec.url}/v1/t/e2e-bot/ask`, { method: 'POST' })).status === 401);
  const fired = await api('POST', '/v1/t/e2e-bot/ask', { input: 'Say hello.' });
  check('it fires at the shared Husk’s address, and the bot answers', fired.status === 200 && /Hello from the stub model/.test(fired.body.text ?? ''), JSON.stringify(fired.body).slice(0, 200));
  const runs = (await api('GET', '/v1/runs?husk=e2e-bot')).body;
  check('the shared Husk ran it: the run is in its own list', Boolean(fired.body.runId) && JSON.stringify(runs).includes(fired.body.runId), JSON.stringify(runs).slice(0, 200));
  check('the bot is deleted', (await api('DELETE', '/v1/husks/e2e-bot')).status === 204);
  for (let i = 0; i < 40 && alive(jobs.pid); i++) await sleep(250);
  check('the job host leaves once no bot has a trigger', !alive(jobs.pid) && !readRecord('jobs.json'), `pid ${jobs.pid}`);
}

/**
 * Bots obey a take-over (J5-e): the person takes a bot's computer, the bot's
 * schedule fires, and the run waits, saying so once, until they give it back;
 * then it runs its command and finishes. A chat would be told to stop instead.
 */
async function checkScheduledRunPauses() {
  const name = 'e2e-sched';
  const spec = { name, model: 'ollama/qwen2.5:7b', persona: 'Use the computer.', tools: ['computer'], computer: { flavor: 'full' } };
  check('a bot that uses a computer is saved', (await api('POST', '/v1/husks', { spec })).status === 201);
  const first = await api('POST', `/v1/husks/${name}/run`, { input: 'e2e-tool: once' });
  check('it runs a command on a computer of its own', first.status === 200 && /bot-ran/.test(first.body.text ?? ''), JSON.stringify(first.body).slice(0, 240));
  const computerId = ((await api('GET', `/v1/runs/${first.body.runId}`)).body.events ?? []).find((e) => e.type === 'computer_ready')?.computerId;
  check('its run names the computer', Boolean(computerId), String(computerId));
  created.push(computerId);

  const person = { 'x-husk-as': 'person' };
  const taken = await api('POST', `/v1/computers/${computerId}/takeover`, undefined, rec.token, person);
  check("the person takes the bot's computer", taken.status === 201, JSON.stringify(taken.body).slice(0, 160));
  const scheduled = { ...spec, triggers: [{ type: 'cron', schedule: '* * * * *', prompt: 'e2e-tool: on schedule' }] };
  check('the bot gets a schedule, every minute', (await api('PUT', `/v1/husks/${name}`, { spec: scheduled })).status === 200);
  let run;
  for (let i = 0; i < 300 && !run; i++) {
    await sleep(250);
    run = ((await api('GET', `/v1/runs?husk=${name}`)).body.runs ?? []).find((r) => r.runId !== first.body.runId);
  }
  check('the schedule fires while the person has the computer', Boolean(run), run?.runId ?? 'no scheduled run in 75 s');
  await sleep(4000);
  const meanwhile = (await api('GET', `/v1/runs/${run.runId}`)).body.result;
  check('the scheduled run waits: it is still running, its command not run', meanwhile?.status === 'running', JSON.stringify(meanwhile).slice(0, 200));

  await api('POST', `/v1/handoffs/${taken.body.handoffId}/done`, undefined, rec.token, person);
  let after;
  for (let i = 0; i < 240; i++) {
    after = (await api('GET', `/v1/runs/${run.runId}`)).body;
    if (after.result?.stopReason) break;
    await sleep(250);
  }
  check('given back, the run goes on, runs its command and finishes', after?.result?.stopReason === 'complete' && /bot-ran/.test(after.result.text ?? ''), JSON.stringify(after?.result).slice(0, 240));
  const pauses = (after?.events ?? []).filter((e) => e.type === 'warning' && /^Paused: a person took over/.test(e.message));
  check('its record says it paused, once', pauses.length === 1, `${pauses.length} pause notes`);
  check('the bot is deleted', (await api('DELETE', `/v1/husks/${name}`)).status === 204);
  const gone = await api('DELETE', `/v1/computers/${computerId}?confirm=${computerId}`, undefined, rec.token, person);
  if (gone.status === 204) created.splice(created.indexOf(computerId), 1);
}

/**
 * A Codex chat becomes a bot (J5-d). Codex hands its MCP servers no session
 * id, so the chat names its computer by the id the first answer carries, and
 * Make this a bot finds the chat's rollout by that id.
 */
async function checkCodexChatBot() {
  const chat = mcpSession(['--provider', 'docker'], { command: process.execPath, args: [bin] });
  await chat.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0' } });
  chat.notify('notifications/initialized');
  const first = textOf((await chat.request('tools/call', { name: 'shell', arguments: { computer: 'new', command: 'uptime' } })).result ?? {});
  const id = /Your computer id is (cmp_[A-Za-z0-9]+)/.exec(first)?.[1];
  check('a Codex chat gets a computer, its id in the first answer', Boolean(id), first.slice(0, 200));
  created.push(id);
  chat.child.stdin.end();

  // What Codex keeps of that chat: one rollout, with Husk's answer in it.
  const day = join(env.CODEX_HOME, 'sessions', '2026', '10', '25');
  mkdirSync(day, { recursive: true });
  const line = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
  writeFileSync(
    join(day, 'rollout-2026-10-25T10-00-00-e2e0c0de.jsonl'),
    [
      line('session_meta', { id: 'e2e-codex-chat', cwd: '/work', cli_version: '0.147.0' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the uptime every hour and tell me if it restarts.' }] }),
      line('response_item', { type: 'function_call', namespace: 'mcp__husk', name: 'shell', arguments: '{"command":"uptime"}', call_id: 'c1' }),
      line('response_item', { type: 'function_call_output', call_id: 'c1', output: first }),
    ].join('\n'),
  );
  const draft = await api('POST', `/v1/computers/${id}/bot`, {});
  check('Make this a bot reads the Codex chat back by its rollout', draft.status === 200 && draft.body.transcriptId === 'e2e-codex-chat', JSON.stringify(draft.body).slice(0, 300));
  // No Codex here, but the stand-in Claude Code is: the draft runs on it, fresh, with the computer.
  check(
    'the draft runs on an installed CLI, from what was distilled, with the computer',
    draft.body.spec?.engine?.type === 'claude-code' && !draft.body.spec.engine.resume && draft.body.spec.tools?.includes('computer'),
    JSON.stringify(draft.body.spec?.engine),
  );
  const gone = await api('DELETE', `/v1/computers/${id}?confirm=${id}`, undefined, rec.token, { 'x-husk-as': 'person' });
  if (gone.status === 204) created.splice(created.indexOf(id), 1);
}

/**
 * A bot on the person's own Claude Code, going on with a chat (J5-c): the chat
 * leaves a file on its computer; the bot, run by the shared Husk, starts the
 * stand-in `claude` on a fork of that chat, with no tool of its own, and its
 * MCP server lands on the chat's computer, where the file is.
 */
async function checkClaudeCodeBot() {
  const sid = 'e2e0c1a2-0000-4000-8000-00000000c0de';
  const chat = mcpSession(['--provider', 'docker'], { command: process.execPath, args: [bin], env: { CLAUDE_CODE_SESSION_ID: sid } });
  await chat.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '0' } });
  chat.notify('notifications/initialized');
  const wrote = textOf((await chat.request('tools/call', { name: 'shell', arguments: { command: 'echo chat-was-here > /work/marker && echo written' } })).result ?? {});
  check('a Claude Code chat leaves a file on its computer', /written/.test(wrote), wrote.slice(0, 200));
  const computer = (await api('GET', '/v1/overview')).body.computers.find((c) => c.spec?.labels?.['husk.session'] === sid);
  if (computer) created.push(computer.id);
  chat.child.stdin.end();

  const spec = { name: 'e2e-cc-bot', persona: 'Say what the chat left.', engine: { type: 'claude-code', resume: sid } };
  const saved = await api('POST', '/v1/husks', { spec });
  check('a bot that goes on with the chat, on Claude Code, is saved', saved.status === 201, JSON.stringify(saved.body).slice(0, 200));
  const ran = await api('POST', '/v1/husks/e2e-cc-bot/run', { input: 'What did the chat leave?' });
  check("the bot runs on the person's Claude Code, through Husk's tools", ran.status === 200 && ran.body.stopReason === 'complete', JSON.stringify(ran.body).slice(0, 300));
  check("on the chat's own computer, with the chat's file", /chat-was-here/.test(ran.body.text ?? '') && /from-the-bot/.test(ran.body.text ?? ''), (ran.body.text ?? '').slice(0, 300));
  const argv = JSON.parse(readFileSync(join(home, 'claude-argv.json'), 'utf8'));
  check(
    'Claude Code went on with a fork of the chat, with no tool of its own',
    argv.join(' ').includes(`--resume ${sid} --fork-session`) && argv[argv.indexOf('--tools') + 1] === '' && argv.includes('--strict-mcp-config'),
    argv.join(' ').slice(0, 300),
  );
  const runs = (await api('GET', '/v1/runs?husk=e2e-cc-bot')).body.runs ?? [];
  check("the run is the shared Husk's, named for Claude Code", runs[0]?.model === 'claude-code', JSON.stringify(runs[0] ?? {}).slice(0, 200));
  check('the bot is deleted', (await api('DELETE', '/v1/husks/e2e-cc-bot')).status === 204);
  if (computer) {
    const gone = await api('DELETE', `/v1/computers/${computer.id}?confirm=${computer.id}`, undefined, rec.token, { 'x-husk-as': 'person' });
    if (gone.status === 204) created.splice(created.indexOf(computer.id), 1);
  }
}

/**
 * The support matrix (docs/clients.md, J6-a): each app as it starts Husk and
 * speaks to it, with its own name, protocol version and capabilities, as far as
 * the matrix knows them. An app with a config file starts the entry setup wrote
 * into it; Claude Code and Codex add Husk with their own CLIs, which CI does not
 * have, so they start the same launch line. Perplexity's name is not known: it
 * stands for any app Husk does not know.
 */
const UI = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const DESKTOP = { app: 'claude-desktop', file: ['.config', 'Claude', 'claude_desktop_config.json'], key: 'mcpServers' };
const CLIENTS = [
  { label: 'Claude Desktop', ...DESKTOP, name: 'claude-ai', protocol: '2025-11-25', caps: UI, platform: 'Claude Desktop' },
  { label: 'Claude Desktop’s Code tab', ...DESKTOP, name: 'local-agent-mode-husk', protocol: '2025-11-25', caps: { roots: {}, ...UI }, platform: 'Claude Desktop' },
  // Its v2 runtime opens on 2026-07-28, with no initialize; an older one, or MCP_PROTOCOL_NEGOTIATION=legacy, on 2025-11-25.
  { label: 'Claude Code', name: 'claude-code', protocol: '2026-07-28', modern: true, caps: { elicitation: {} }, session: `e2e-${process.pid}`, platform: 'Claude Code', inChat: true },
  { label: 'Claude Code on 2025-11-25', name: 'claude-code', protocol: '2025-11-25', caps: { elicitation: {} }, session: `e2e-legacy-${process.pid}`, platform: 'Claude Code', inChat: true },
  { label: 'Codex', name: 'codex-mcp-client', protocol: '2025-06-18', caps: { elicitation: {} }, platform: 'Codex' },
  { label: 'Cursor', app: 'cursor', file: ['.cursor', 'mcp.json'], key: 'mcpServers', name: 'cursor-vscode', protocol: '2025-06-18', caps: { elicitation: {} }, platform: 'Cursor', inChat: true },
  { label: 'VS Code', app: 'vscode', file: ['.config', 'Code', 'User', 'mcp.json'], key: 'servers', name: 'Visual Studio Code', protocol: '2025-11-25', caps: { elicitation: { form: {} } }, platform: 'VS Code', inChat: true, waits: true },
  { label: 'Windsurf', app: 'windsurf', file: ['.codeium', 'windsurf', 'mcp_config.json'], key: 'mcpServers', name: 'windsurf', protocol: '2025-06-18', platform: 'Windsurf' },
  { label: 'Zed', app: 'zed', file: ['.config', 'zed', 'settings.json'], key: 'context_servers', name: 'Zed', protocol: '2025-11-25', platform: 'Zed', long: true },
  { label: 'Gemini CLI', app: 'gemini', file: ['.gemini', 'settings.json'], key: 'mcpServers', name: 'gemini-cli-mcp-client', protocol: '2025-06-18', caps: { roots: { listChanged: true } }, platform: 'Gemini CLI' },
  { label: 'Perplexity', name: 'Perplexity', protocol: '2025-06-18', platform: 'Perplexity' },
];

/**
 * Setup connects every app with a config file, in a home of this check's own,
 * then each app's chat runs against Husk (checkClient).
 */
async function checkClients() {
  const own = join(home, 'clients');
  const config = join(own, '.config');
  // Zed's first settings file is mostly comments, which setup must keep.
  mkdirSync(join(config, 'zed'), { recursive: true });
  writeFileSync(join(config, 'zed', 'settings.json'), '// Zed settings\n{\n  "ui_font_size": 16,\n}\n');
  const apps = [...new Set(CLIENTS.flatMap((c) => (c.app ? [c.app] : [])))];
  const setup = spawnSync(process.execPath, [cli, 'setup', '--computer', 'docker', '--apps', apps.join(','), '--yes', '--no-start'], {
    env: { ...env, HOME: own, XDG_CONFIG_HOME: config, HUSK_LAUNCH: JSON.stringify({ command: process.execPath, args: [bin] }) },
    encoding: 'utf8',
    timeout: 300_000,
  });
  check(`setup connects ${apps.join(', ')}, each in its own file`, setup.status === 0, `${setup.stdout ?? ''}${setup.stderr ?? ''}`.slice(-600));
  const zed = readFileSync(join(config, 'zed', 'settings.json'), 'utf8');
  check('setup keeps the comments in Zed’s settings', zed.startsWith('// Zed settings\n{') && zed.includes('"ui_font_size": 16,'), zed.slice(0, 200));
  // The files hold no `//` but a comment's, nor a `,}` but a trailing comma's.
  const entryOf = (c) => JSON.parse(readFileSync(join(own, ...c.file), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))[c.key]?.husk;
  for (const c of CLIENTS) await checkClient(c, entryOf(c.file ? c : DESKTOP), Boolean(c.file));
}

/**
 * One app's chat: Husk answers in a protocol the app speaks, lists tools that
 * fit every app's limits, names the chat's computer for the app, answers a call
 * longer than the app allows before the app gives up (one app with a 60 s
 * limit), and asks "Done?" in the chat only where the app shows it.
 */
async function checkClient(c, entry, fromFile) {
  const say = (what) => `${c.label}: ${what}`;
  if (fromFile) {
    const shaped = entry?.command === process.execPath && entry.args?.[0] === bin && (c.key !== 'servers' || entry.type === 'stdio');
    check(say(`setup wrote its entry under ${c.key}, in the app’s own shape`), shaped, JSON.stringify(entry));
  }
  let asked = 0;
  const chatEnv = { ...env, ...(c.session ? { CLAUDE_CODE_SESSION_ID: c.session } : {}) };
  if (!c.session) delete chatEnv.CLAUDE_CODE_SESSION_ID;
  const chat = mcpSession([], entry, {
    env: chatEnv,
    answer: (msg) => (msg.method === 'elicitation/create' ? (asked++, { action: 'accept', content: { done: true } }) : undefined),
  });
  // 2026-07-28 has no initialize: the app opens with server/discover, and every request says who is asking.
  const envelope = {
    'io.modelcontextprotocol/protocolVersion': c.protocol,
    'io.modelcontextprotocol/clientInfo': { name: c.name, version: '0' },
    'io.modelcontextprotocol/clientCapabilities': c.caps ?? {},
  };
  const ask = (method, params = {}) => chat.request(method, c.modern ? { ...params, _meta: envelope } : params);
  let mine;
  try {
    if (c.modern) {
      const found = await ask('server/discover');
      check(say('Husk answers server/discover, offering 2026-07-28'), found.result?.supportedVersions?.includes(c.protocol), JSON.stringify(found.result?.supportedVersions ?? found.error));
    } else {
      const init = await chat.request('initialize', { protocolVersion: c.protocol, capabilities: c.caps ?? {}, clientInfo: { name: c.name, version: '0' } });
      check(say(`Husk answers in ${c.protocol}`), init.result?.protocolVersion === c.protocol, JSON.stringify(init.result?.protocolVersion ?? init.error));
      chat.notify('notifications/initialized');
    }
    const names = ((await ask('tools/list')).result?.tools ?? []).map((t) => t.name);
    // The strictest of each limit: Cascade's 100 tools, Cursor's 60 characters for
    // server and tool together, Gemini CLI's 63 for mcp_<server>_<tool>.
    const fits = names.length <= 100 && names.every((n) => /^[a-z][a-z0-9_]*$/.test(n) && `husk${n}`.length <= 60 && `mcp_husk_${n}`.length <= 63);
    check(say(`its ${names.length} tools fit every app’s limits, with job_wait only where the app gives up on a call`), fits && names.includes('shell') && names.includes('job_wait') !== Boolean(c.waits), names.join(' '));

    const known = new Set((await api('GET', '/v1/overview')).body.computers.map((x) => x.id));
    const target = (id) => (c.session ? {} : { computer: id });
    const hello = textOf((await ask('tools/call', { name: 'shell', arguments: { ...target('new'), command: 'echo from-the-app' } })).result ?? {});
    mine = (await api('GET', '/v1/overview')).body.computers.find((x) => !known.has(x.id));
    if (mine) created.push(mine.id);
    const platform = mine?.spec?.labels?.['husk.platform'];
    check(say(`a chat’s computer is named for ${c.platform}`), /from-the-app/.test(hello) && platform === c.platform, `${platform}; ${hello.slice(0, 160)}`);

    if (c.long) {
      const started = Date.now();
      const first = textOf((await ask('tools/call', { name: 'shell', arguments: { ...target(mine.id), command: 'sleep 58; echo after-the-wait' } })).result ?? {});
      const secs = Math.round((Date.now() - started) / 1000);
      const job = /job_wait with job "([\w-]+)"/.exec(first)?.[1];
      check(say(`a call longer than its 60 s answers "still running" in time (${secs}s)`), Boolean(job) && secs < 58, first.slice(0, 200));
      const rest = textOf((await ask('tools/call', { name: 'job_wait', arguments: { job } })).result ?? {});
      check(say('job_wait collects the rest'), /after-the-wait/.test(rest), rest.slice(0, 200));
    }

    const handOff = { name: 'hand_off', arguments: { ...target(mine.id), reason: 'e2e: the per-app check.' } };
    let reply = await ask('tools/call', handOff);
    // On 2026-07-28 the "Done?" comes back as input_required, and the app calls again with the answer.
    const round = reply.result?.resultType === 'input_required' ? reply.result : undefined;
    if (round?.inputRequests?.done?.method === 'elicitation/create') {
      asked++;
      reply = await ask('tools/call', { ...handOff, inputResponses: { done: { action: 'accept', content: { done: true } } }, requestState: round.requestState });
    }
    const handed = textOf(reply.result ?? {});
    if (c.inChat) {
      const how = c.modern ? 'by input_required' : 'in the chat';
      check(say(`asks "Done?" ${how}, and the computer is the AI’s again`), asked === 1 && Boolean(round) === Boolean(c.modern) && /computer is yours again/.test(handed), handed.slice(0, 200));
    } else {
      const handoff = /^Handoff (\S+) is open/.exec(handed)?.[1];
      check(say('gives a link to relay instead'), asked === 0 && Boolean(handoff) && /#handoff=/.test(handed), handed.slice(0, 200));
      await ask('tools/call', { name: 'hand_off_done', arguments: { handoff } });
    }
  } finally {
    chat.child.stdin.end();
    if (mine) {
      const gone = await api('DELETE', `/v1/computers/${mine.id}?confirm=${mine.id}`, undefined, rec.token, { 'x-husk-as': 'person' });
      if (gone.status === 204) created.splice(created.indexOf(mine.id), 1);
    }
  }
}

/** fetch to a port on this machine under another name, as a tunnel delivers a request: Node's own fetch will not set Host. */
function tunnelFetch(port, host) {
  return (url, init = {}) =>
    new Promise((resolveFetch, reject) => {
      const u = new URL(String(url instanceof Request ? url.url : url));
      const headers = { ...Object.fromEntries(new Headers(init.headers ?? {})), host };
      const req = httpRequest({ host: '127.0.0.1', port, method: init.method ?? 'GET', path: `${u.pathname}${u.search}`, headers }, (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [v].flat()) if (x !== undefined) h.append(k, String(x));
        const empty = res.statusCode === 204 || res.statusCode === 304;
        resolveFetch(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: h }));
      });
      req.on('error', reject);
      init.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')));
      req.end(init.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(init.body));
    });
}

/** CBOR for a software authenticator's answers: unsigned and negative integers, strings, bytes, maps. */
function cbor(value) {
  const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

/** A passkey, made and used in software: what a phone or a security key does for the owner. */
function softwarePasskey(rpId, origin) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = randomBytes(16);
  let count = 0;
  const rpHash = createHash('sha256').update(rpId).digest();
  const counter = () => Buffer.from([0, 0, 0, ++count]);
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString('base64url');
  return {
    create(challenge) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), counter(), Buffer.alloc(16), Buffer.from([0, id.length]), id, cbor(cose)]);
      return { clientDataJSON: clientData('webauthn.create', challenge), attestationObject: cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url') };
    },
    get(challenge) {
      const clientDataJSON = clientData('webauthn.get', challenge);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), counter()]);
      const signed = Buffer.concat([authData, createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()]);
      return { id: id.toString('base64url'), clientDataJSON, authenticatorData: authData.toString('base64url'), signature: sign('sha256', signed, privateKey).toString('base64url') };
    },
  };
}

/** A free port on loopback, for a server this run starts. */
const freePort = () =>
  new Promise((r) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => r(p));
    });
  });

/**
 * Remote access (J6-c), as a chat app on the web reaches it: `husk serve
 * --remote` on a home of its own, a tunnel's requests on remote access's own
 * port named for the public URL, as Tailscale Funnel delivers them, the
 * owner's first sign-in with the claim code and a new passkey, then MCP over
 * HTTP on 2026-07-28 to a real Docker computer, which remote chats alone can
 * reach. The advisory check asks a registry of this run's, so the run does
 * not turn on the advisories of the day; the real registry's answer is read
 * once, as a note.
 */
async function checkRemoteAccess() {
  const NAME = 'e2e.husk.test';
  const PUBLIC = `https://${NAME}`;
  const own = join(home, 'remote');
  mkdirSync(own, { recursive: true });
  const port = await freePort();
  const remotePort = await freePort();

  try {
    const res = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minimist: ['1.2.5'] }),
      signal: AbortSignal.timeout(15_000),
    });
    const found = (await res.json()).minimist ?? [];
    note(
      'the npm registry’s bulk advisory endpoint answers in the shape Husk reads',
      found.some((a) => a.severity === 'critical' && /^https:\/\//.test(a.url) && typeof a.vulnerable_versions === 'string' && a.title),
      JSON.stringify(found[0] ?? {}).slice(0, 200),
    );
  } catch (err) {
    note('the npm registry’s bulk advisory endpoint answers in the shape Husk reads', false, `not reached: ${err.message}`);
  }
  let answer = {};
  const registry = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(answer));
  });
  await new Promise((r) => registry.listen(0, '127.0.0.1', r));
  const serveEnv = { ...env, HUSK_HOME: own, NO_COLOR: '1', HUSK_ADVISORY_ENDPOINT: `http://127.0.0.1:${registry.address().port}/` };
  const args = [cli, 'serve', '--remote', '--public-url', PUBLIC, '--port', String(port), '--remote-port', String(remotePort), '--provider', 'docker'];

  // Never spawnSync here: it would stop this process, and with it the registry the child asks.
  const run = (argv, ms) =>
    new Promise((resolveRun) => {
      const child = spawn(process.execPath, argv, { env: serveEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (c) => (text += c));
      child.stderr.on('data', (c) => (text += c));
      const timer = setTimeout(() => child.kill('SIGTERM'), ms);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolveRun({ status, text });
      });
    });

  let serving;
  let computer;
  let ownRec;
  try {
    // A critical advisory against this install: it will not start, and says which and where to read it.
    answer = { minimist: [{ title: 'Prototype Pollution in minimist', severity: 'critical', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', vulnerable_versions: '<1.2.6' }] };
    const refused = await run(args, 60_000);
    check(
      'a high or critical advisory stops husk serve --remote from starting, and names it',
      refused.status !== null && refused.status !== 0 && /will not start/.test(refused.text) && /GHSA-xvch-5gv4-984h/.test(refused.text),
      `${refused.status}: ${refused.text.slice(-300)}`,
    );
    answer = {};

    serving = spawn(process.execPath, args, { env: serveEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    serving.stdout.on('data', (c) => (out += c));
    serving.stderr.on('data', (c) => (out += c));
    for (let i = 0; i < 240 && !/no owner yet/.test(out) && serving.exitCode === null; i++) await sleep(250);
    // Its output here is a pipe, as a service's is a log: the claim code is asked for, never written there.
    const claimed = await run([cli, 'remote', 'claim', '--json'], 30_000);
    const claim = /"code":\s*"([0-9A-Z-]{19})"/.exec(claimed.text)?.[1];
    check(
      'husk serve --remote starts on docker computers, keeps the claim code out of its output, and husk remote claim gives one',
      Boolean(claim) && /husk remote claim/.test(out) && !/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/.test(out),
      `${out.slice(-300)} | ${claimed.text.slice(0, 80)}`,
    );
    check('it names remote access’s own port as the one to publish', out.includes(`publish port ${remotePort}`), out.slice(-400));
    ownRec = JSON.parse(readFileSync(join(own, 'daemon.json'), 'utf8'));
    const f = tunnelFetch(remotePort, NAME);
    // Whatever Host a tunnel passes on, its port is remote access alone, and the API's port serves none of it.
    const spoofed = await tunnelFetch(remotePort, '127.0.0.1')(`${PUBLIC}/v1/computers`, { headers: { authorization: `Bearer ${ownRec.token}` } });
    const wrongPort = await tunnelFetch(port, NAME)(`${PUBLIC}/.well-known/oauth-authorization-server`);
    check('a tunnel’s Host decides nothing: the API is not on its port, and remote access is not on the API’s', spoofed.status === 404 && wrongPort.status === 404, `${spoofed.status}, ${wrongPort.status}`);
    const json = async (path, body, extra = {}) => {
      const r = await f(`${PUBLIC}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: PUBLIC, ...extra }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    const bare = await f(`${PUBLIC}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('/mcp without a token answers where to sign in', bare.status === 401 && /resource_metadata=/.test(bare.headers.get('www-authenticate') ?? ''), String(bare.status));
    const api = await f(`${PUBLIC}/v1/computers`, { headers: { authorization: `Bearer ${ownRec.token}` } });
    check('the API is not under the public URL, even with this machine’s token', api.status === 404, String(api.status));

    // The owner's first sign-in, as claude.ai or ChatGPT would send them through it.
    const callback = 'https://claude.ai/api/mcp/auth_callback';
    const reg = await json('/oauth/register', { redirect_uris: [callback], client_name: 'e2e-app' });
    const client = reg.body.client_id;
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      response_type: 'code', client_id: client, redirect_uri: callback, state: 's1', resource: `${PUBLIC}/mcp`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    const page = await (await f(`${PUBLIC}/oauth/authorize?${q}`)).text();
    const request = /"request":"([^"]+)"/.exec(page)?.[1];
    const passkey = softwarePasskey(NAME, PUBLIC);
    const options = await json('/oauth/claim', { request, code: claim });
    const made = await json('/oauth/passkey', { request, credential: passkey.create(options.body.publicKey?.challenge) });
    const allowed = await json('/oauth/consent', { request, allow: true });
    const code = new URL(allowed.body.redirect ?? callback).searchParams.get('code');
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: client, code_verifier: verifier, resource: `${PUBLIC}/mcp` });
    const tokens = await (await f(`${PUBLIC}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })).json();
    check('the owner claims it with the code and a new passkey, and the app gets its tokens', reg.status === 201 && made.status === 200 && Boolean(tokens.access_token), JSON.stringify({ reg: reg.status, made: made.status, token: tokens.error }));

    // The app's chat, over MCP on 2026-07-28, on a computer of its own.
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const signed = (url, init = {}) => f(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers ?? {})), authorization: `Bearer ${tokens.access_token}` } });
    const app = new Client({ name: 'e2e-app', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await app.connect(new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), { fetch: signed }));
    const textOfCall = (r) => (r.content ?? []).map((c) => c.text ?? '').join('\n');
    const command = 'echo remote-ok; uname -s';
    // A command waits for the owner's word: the first call answers with the page, and runs nothing.
    const asked = textOfCall(await app.callTool({ name: 'shell', arguments: { computer: 'new', command } }));
    const link = /(https:\/\/e2e\.husk\.test\/oauth\/approve\?id=[\w-]+)/.exec(asked)?.[1];
    const id = /computer: "(cmp_\w+)"/.exec(asked)?.[1];
    check('a command from the web waits for the owner’s approval, and nothing runs', Boolean(link && id) && !/remote-ok/.test(asked), asked.slice(0, 240));
    const approval = new URL(link).searchParams.get('id');
    const pageOk = (await f(link)).status === 200;
    const step = await json('/oauth/approve/start', { id: approval });
    const approved = await json('/oauth/approve', { id: approval, allow: true, credential: passkey.get(step.body.publicKey?.challenge) });
    check('the owner approves it with their passkey, at its page under the public URL', pageOk && approved.status === 200, JSON.stringify(approved.body));
    const text = textOfCall(await app.callTool({ name: 'shell', arguments: { computer: id, command } }));
    const overview = await (await fetch(`${ownRec.url}/v1/overview`, { headers: { authorization: `Bearer ${ownRec.token}` } })).json();
    computer = overview.computers.find((c) => c.spec?.labels?.['husk.platform'] === 'e2e-app');
    check(
      'then it runs, on a docker computer of the chat’s own, named for its app',
      app.getProtocolEra() === 'modern' && /remote-ok/.test(text) && /Linux/.test(text) && computer?.provider === 'docker' && computer.id === id,
      `${text.slice(0, 200)}; ${computer?.provider}`,
    );

    // Sign in for me, from wherever the person is: the handoff's link is under
    // the public URL, and starts at the owner's passkey, since the chat holds the link too.
    const handed = textOfCall(await app.callTool({ name: 'hand_off', arguments: { computer: id, reason: 'e2e: sign in from the web.' } }));
    const view = /(https:\/\/e2e\.husk\.test\/oauth\/link#handoff=([\w-]+)&token=([\w.-]+))/.exec(handed);
    const linkToken = view ? decodeURIComponent(view[3]) : '';
    const linkPage = view ? await f(view[1]) : undefined;
    const alone = view ? await f(`${PUBLIC}/v1/handoffs/${view[2]}`, { headers: { authorization: `Bearer ${linkToken}` } }) : undefined;
    const presence = await json('/oauth/link/start', {});
    const session = (await json('/oauth/link', { id: presence.body.id, credential: passkey.get(presence.body.publicKey?.challenge) })).body.session;
    const opened = view ? await f(`${PUBLIC}/v1/handoffs/${view[2]}`, { headers: { authorization: `Bearer ${linkToken}`, 'x-husk-owner': session ?? '' } }) : undefined;
    check(
      'a remote chat’s handoff link opens under the public URL only after the owner’s passkey',
      linkPage?.status === 200 && alone?.status === 401 && Boolean(session) && opened?.status === 200,
      `${handed.slice(0, 160)}; page ${linkPage?.status}, alone ${alone?.status}, with the passkey ${opened?.status}`,
    );
    const handoff = /^Handoff (\S+) is open/m.exec(handed)?.[1];
    if (handoff) await app.callTool({ name: 'hand_off_done', arguments: { handoff } });
    await app.close();

    // The owner's switch, on this machine: off signs every app out and makes the public URL a 404.
    const here = (method, path) => fetch(`${ownRec.url}${path}`, { method, headers: { authorization: `Bearer ${ownRec.token}` } }).then((r) => r.json());
    const mcpStatus = async () => (await signed(`${PUBLIC}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
    const off = await here('POST', '/v1/remote/off');
    const whileOff = await mcpStatus();
    const on = await here('POST', '/v1/remote/on');
    const afterOn = await mcpStatus();
    check(
      'switched off, the public URL is a 404 and every app signed out; on again, the old token is no good',
      off.on === false && off.apps?.length === 0 && whileOff === 404 && on.on === true && afterOn === 401,
      JSON.stringify({ off: off.on, apps: off.apps?.length, whileOff, on: on.on, afterOn }),
    );
  } finally {
    if (computer && ownRec) {
      await fetch(`${ownRec.url}/v1/computers/${computer.id}?confirm=${computer.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${ownRec.token}`, 'x-husk-as': 'person' } }).catch(() => undefined);
    }
    serving?.kill('SIGTERM');
    // Whatever failed above: a server left open here keeps the whole run alive until the job's timeout.
    registry.closeAllConnections();
    registry.close();
  }
}

try {
  // 1. A fresh home and a non-interactive setup, as the README's line runs it:
  // Husk added to one chat app on the computer chosen, the image with the
  // browser pulled now, and the shared Husk started. HUSK_LAUNCH points the app
  // at this build (npm has no 0.2 yet), and XDG_CONFIG_HOME keeps the app's
  // settings in this run's own folder.
  const xdg = join(home, 'xdg');
  mkdirSync(join(xdg, 'Claude'), { recursive: true });
  const setupEnv = { ...env, XDG_CONFIG_HOME: xdg, HUSK_LAUNCH: JSON.stringify({ command: process.execPath, args: [bin] }) };
  const setup = spawnSync(process.execPath, [cli, 'setup', '--computer', 'docker', '--apps', 'claude-desktop', '--yes'], {
    env: setupEnv,
    encoding: 'utf8',
    timeout: 1_200_000,
  });
  console.log(`${setup.stdout ?? ''}${setup.stderr ?? ''}`.trim().replace(/token=[0-9a-f]+/g, 'token=<redacted>'));
  check('a non-interactive setup finishes', setup.status === 0, `exit ${setup.status}`);
  appEntry = JSON.parse(readFileSync(join(xdg, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers?.husk;
  check(
    'setup adds Husk to the chat app, on the computer chosen',
    appEntry?.command === process.execPath && appEntry.args?.[0] === bin && appEntry.args.join(' ').includes('--provider docker'),
    JSON.stringify(appEntry?.args),
  );
  const image = resolveImage({ flavor: 'full' }).primary;
  check('setup gets the image with the browser before any chat', spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0, image);
  rec = readDaemon();
  check('setup starts the shared Husk, which writes daemon.json', Boolean(rec?.token), rec?.url);
  check('the console page loads without the token', (await fetch(`${rec.url}/`)).status === 200);
  check('the API refuses a request without the token', (await fetch(`${rec.url}/v1/computers`)).status === 401);

  // 1b. A bot's trigger runs in a job host of its own, through the shared Husk.
  await checkJobHost();

  // 1c. A bot on the person's own Claude Code goes on with a chat, on the chat's computer.
  await checkClaudeCodeBot();

  // 1d. A Codex chat becomes a bot, read back by the rollout that names its computer.
  await checkCodexChatBot();

  // 1e. A bot's scheduled run waits while a person has its computer (J5-e).
  await checkScheduledRunPauses();

  // 1f. Every chat app in the support matrix, as it starts and speaks to Husk (J6-a).
  await checkClients();

  // 1g. A chat app on the web, through a tunnel: remote access (J6-c).
  await checkRemoteAccess();

  // 1h. Packages on a docker computer, which cannot install them itself.
  await checkPackages();

  // 2. A Docker computer with a browser.
  // Unique: the name is the container's, and another `e2e` container would clash.
  // Labelled the way Husk labels a Claude Code chat's computer, so every picture shows that app's mark.
  const made = await api('POST', '/v1/computers', {
    name: `e2e-${process.pid}-${Date.now()}`,
    provider: 'docker',
    flavor: 'full',
    labels: { 'husk.platform': 'Claude Code' },
  });
  check('a docker computer is created', made.status === 201, JSON.stringify(made.body).slice(0, 300));
  const id = made.body.id;
  created.push(id);

  // 3. Chat tools through the shared route.
  const uname = textOf(await tool(id, 'shell', { command: 'uname -sr' }));
  check('shell runs in Linux', /Linux/.test(uname), uname.trim());
  await tool(id, 'write_file', { path: '/work/hello.txt', content: 'from the e2e\n' });
  check('write_file then read_file', textOf(await tool(id, 'read_file', { path: '/work/hello.txt' })).includes('from the e2e'));
  await serveFixture(id);
  const goto = await tool(id, 'browser_goto', { url: FIXTURE });
  check('the browser renders a page', !goto.isError && /Husk fixture/i.test(textOf(goto)), JSON.stringify(textOf(goto).slice(0, 200)));
  const snap = await tool(id, 'browser_snapshot');
  // Elements with refs a model can click, e.g. `e24  link "First link"`, indented
  // by depth in the compact tree.
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
  check('the activity timeline has the calls', activity.length >= 5 && gotoEntry?.summary === FIXTURE, `${activity.length} entries`);

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
  check(
    'tools are refused while the person holds it, with a code that stays the same',
    held.isError === true && /^E_COMPUTER_HELD \(handoff\): .*has the computer/.test(textOf(held)),
    textOf(held).slice(0, 160),
  );
  const done = await api('POST', `/v1/handoffs/${opened.body.handoffId}/done`, undefined, link);
  check('done with the link ends it', done.body.outcome === 'done');
  check('tools run again after done', !(await tool(id, 'shell', { command: 'echo back' })).isError);

  // 7. A real MCP session forwards its tools to the shared Husk. No --flavor:
  // a chat gets the image that runs the browser, as `claude mcp add` gives it.
  mcp = mcpSession(['--provider', 'docker']);
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
  if (chatComputer) {
    await serveFixture(chatComputer.id);
    const page = await mcp.request('tools/call', { name: 'browser_goto', arguments: { computer: chatComputer.id, url: FIXTURE } });
    const pageText = textOf(page.result ?? {});
    check('a chat with no --flavor opens a page in its browser', /Husk fixture/.test(pageText), pageText.slice(0, 200));
  }
  mcp.child.stdin.end();
  await sleep(1000);

  // 7b. Stopping a command stops it inside the computer.
  await checkStops(id);

  // 8. How fast the browser is, for before-and-after numbers.
  await measureBrowser(id);

  // 8b. A script that makes its own decisions, run inside the computer.
  await measureScript(id);

  // 8c. Clicks that are honest about where they land, and refs that expire.
  await checkHonestClicks(id);
  await checkFreshRefs(id);
  await checkDialogsDownloadsTabs(id);
  await checkFrames(id);
  await checkBrowserRecovers(id);
  await checkPolicyBelowTheTool(id);
  await checkFewerTurns(id);
  await checkEveryBrowserTool(id);

  // 8e. The J3 gate: a hard page, end to end.
  await checkHardPageJourney(id);

  // 8f. Husk against Playwright MCP, measured; a measurement never fails the run.
  try {
    await benchmarkAgainstPlaywright(id, made.body.name);
  } catch (err) {
    console.log(`the benchmark was not measured: ${err.message}`);
  }

  // 8d. Taking over stops the AI where it is, scripts included.
  await checkTakeover(id);

  // 9. The console in a real browser: Home's live screen, take over at any
  // moment, the chat's call waiting for Give back, the Chat and Connect pages.
  // CI sets E2E_CONSOLE=1 and installs playwright-core (not a dependency) to
  // drive the runner's own Chrome. Screenshots land in E2E_SHOTS.
  if (process.env.E2E_CONSOLE === '1') await walkConsole(id, made.body.name);
  else console.log('skip the console walkthrough (set E2E_CONSOLE=1 with playwright-core installed)');

  // 9. The desktop app on this Husk: a chat's call opens the computer's own
  // window, the 3D row and the notch (apps/desktop, HUSK_DESKTOP_SMOKE=live).
  // CI sets E2E_DESKTOP=1, installs apps/desktop and runs it under xvfb.
  if (process.env.E2E_DESKTOP === '1') await walkDesktop(id);
  else console.log('skip the desktop app (set E2E_DESKTOP=1 with apps/desktop installed and xvfb-run)');
  // The desktop app's walk ends by killing the shared Husk and starting it again: talk to the new one.
  rec = readDaemon() ?? rec;

  // 10. The chat setup connected goes on when the shared Husk dies under it. Last:
  // what came before ran on the first shared Husk.
  const signingIn = await checkRestart();

  // 11. Sign in for me, across another restart, mid-login (the J2 gate).
  await checkSignIn(signingIn);

  // 12. Delete means delete: the console's Delete erases a chat's computer and its volume.
  await checkDeleteErases(signingIn);

  console.log(`\n${steps.length} checks passed`);
} catch (err) {
  console.error(`\n${err.stack ?? err}`);
  // The shared Husk runs detached, as setup starts it: its own log says what it saw.
  try {
    console.error(`\n--- daemon.log, the end ---\n${readFileSync(join(home, 'daemon.log'), 'utf8').slice(-6000)}`);
  } catch {
    // no log: it never started
  }
  process.exitCode = 1;
} finally {
  await cleanup();
  // The run is over: a server or timer something forgot to close must not hold it to the job's timeout.
  setTimeout(() => process.exit(process.exitCode ?? 0), 5_000).unref();
}
