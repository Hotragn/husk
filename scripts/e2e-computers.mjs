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

import { spawn, spawnSync } from 'node:child_process';
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

/**
 * For a step that needs a third-party site, which is there for the pictures:
 * said, never failing the run. A site being slow or down is not a Husk bug.
 */
function note(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'warn'} ${name}${detail ? ` -- ${detail}` : ''}`);
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

  // 7b. Stopping a command stops it inside the computer.
  await checkStops(id);

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

  // 9. The desktop app on this Husk: a chat's call opens the computer's own
  // window, the 3D row and the notch (apps/desktop, HUSK_DESKTOP_SMOKE=live).
  // CI sets E2E_DESKTOP=1, installs apps/desktop and runs it under xvfb.
  if (process.env.E2E_DESKTOP === '1') await walkDesktop(id);
  else console.log('skip the desktop app (set E2E_DESKTOP=1 with apps/desktop installed and xvfb-run)');

  console.log(`\n${steps.length} checks passed`);
} catch (err) {
  console.error(`\n${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
