/**
 * Export archify viewer HTML to standalone SVG and PNG.
 *
 * The viewer's SVG is styled by CSS classes defined in the page, so lifting the
 * <svg> element out verbatim produces an unstyled skeleton. This walks the live
 * DOM, copies the computed paint/text properties onto each node as presentation
 * attributes, drops the class hooks, and emits a file that renders identically
 * with no stylesheet — which is what GitHub's image pipeline will serve.
 *
 * Drives Chrome over CDP using Node's built-in WebSocket (Node >= 22).
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const DIAGRAMS = process.argv[2];
const OUT = process.argv[3];
const THEMES = ['light', 'dark'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Properties that actually carry the look. Copying everything bloats the file 10x. */
const PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'text-anchor', 'dominant-baseline', 'paint-order',
  'display', 'visibility', 'text-transform',
];

const EXTRACT = `(() => {
  const svg = document.querySelector('svg[data-preset]') || document.querySelector('svg');
  if (!svg) return null;
  const props = ${JSON.stringify(PROPS)};
  const clone = svg.cloneNode(true);
  const src = svg.querySelectorAll('*');
  const dst = clone.querySelectorAll('*');
  // Every SVG paint and text property here is inherited except these two, so a
  // value identical to the parent's can be dropped and left to inheritance.
  // Writing all of them on every node triples the file for no visual gain.
  const NOT_INHERITED = new Set(['opacity', 'display']);
  const INITIAL = { opacity: '1', display: 'inline' };
  // A web font that is not embedded will not resolve on GitHub, npm or in a
  // plain image viewer, and an unterminated stack falls back to serif -- which
  // is how a monospace technical diagram ends up rendering in Times.
  const withGeneric = (stack) => {
    if (/(monospace|sans-serif|serif|system-ui)\\s*$/.test(stack)) return stack;
    return /mono/i.test(stack)
      ? stack + ', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      : stack + ', system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  };
  // The root carries the full baseline: children prune against their parent, so
  // without it the whole inherited chain resolves to browser defaults.
  {
    const cs = getComputedStyle(svg);
    const parts = [];
    for (const p of props) {
      let v = cs.getPropertyValue(p);
      if (!v || v === 'auto') continue;
      if (p === 'font-family') v = withGeneric(v);
      parts.push(p + ':' + v);
    }
    clone.setAttribute('style', parts.join(';'));
  }
  for (let i = 0; i < src.length; i++) {
    const cs = getComputedStyle(src[i]);
    const parent = src[i].parentElement;
    const ps = parent && parent !== document.documentElement ? getComputedStyle(parent) : null;
    const parts = [];
    for (const p of props) {
      let v = cs.getPropertyValue(p);
      // Never drop 'none': fill:none is what keeps a connector a line instead of
      // a filled blob, and it is the default for neither fill nor stroke in SVG.
      if (!v || v === 'normal' || v === 'auto') continue;
      if (NOT_INHERITED.has(p)) {
        if (v === INITIAL[p]) continue;
      } else if (ps && ps.getPropertyValue(p) === v) {
        continue;
      }
      if (p === 'font-family') v = withGeneric(v);
      parts.push(p + ':' + v);
    }
    if (parts.length) dst[i].setAttribute('style', parts.join(';'));
    dst[i].removeAttribute('class');
  }
  clone.removeAttribute('class');
  // The authored viewBox can be tighter than what the renderer actually draws --
  // the legend sits below it -- so fit the box to real content bounds instead of
  // trusting the authored numbers, or the export silently loses the legend.
  const authored = (svg.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number);
  const bb = svg.getBBox();
  const PAD = 12;
  const x0 = Math.min(authored[0] ?? 0, bb.x) - PAD;
  const y0 = Math.min(authored[1] ?? 0, bb.y) - PAD;
  const x1 = Math.max((authored[0] ?? 0) + (authored[2] ?? 0), bb.x + bb.width) + PAD;
  const y1 = Math.max((authored[1] ?? 0) + (authored[3] ?? 0), bb.y + bb.height) + PAD;
  const w = Math.ceil(x1 - x0), h = Math.ceil(y1 - y0);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('viewBox', [x0, y0, w, h].join(' '));
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  // The page background is not part of the SVG; without it a dark export is
  // dark-on-transparent and unreadable wherever the host renders on white.
  const bg = getComputedStyle(document.body).backgroundColor;
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', String(x0));
  rect.setAttribute('y', String(y0));
  rect.setAttribute('width', String(w));
  rect.setAttribute('height', String(h));
  rect.setAttribute('fill', bg);
  clone.insertBefore(rect, clone.firstChild);
  return JSON.stringify({
    svg: '<?xml version="1.0" encoding="UTF-8"?>\\n' + new XMLSerializer().serializeToString(clone),
    width: w, height: h,
  });
})()`;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = c.pending.get(m.id);
      if (p) { c.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  close() { this.ws.close(); }
}

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + path.join(process.env.TEMP || '.', 'archify-export-profile'),
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars',
  '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });

process.on('exit', () => chrome.kill());

// Wait for the debugger to answer.
let version;
for (let i = 0; i < 60; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
  catch { await sleep(500); }
}
if (!version) { console.error('chrome did not start'); process.exit(1); }

const files = (await readdir(DIAGRAMS)).filter((f) => f.endsWith('.html')).sort();
await mkdir(path.join(OUT, 'svg'), { recursive: true });
await mkdir(path.join(OUT, 'png'), { recursive: true });

let done = 0, failed = 0;
for (const file of files) {
  const name = file.replace(/\.html$/, '');
  for (const theme of THEMES) {
    const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
    try {
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1800, height: 1200, deviceScaleFactor: 1, mobile: false,
      });
      const url = pathToFileURL(path.join(DIAGRAMS, file)).href + `?theme=${theme}`;
      await cdp.send('Page.navigate', { url });
      await sleep(1600);

      const { result } = await cdp.send('Runtime.evaluate', { expression: EXTRACT, returnByValue: true });
      if (!result.value) throw new Error('no svg found');
      const { svg, width, height } = JSON.parse(result.value);
      const svgPath = path.join(OUT, 'svg', `${name}.${theme}.svg`);
      await writeFile(svgPath, svg, 'utf8');

      // Rasterise the exported SVG rather than the viewer page, so the PNG is a
      // pixel-for-pixel render of the very file being shipped -- if the SVG is
      // broken the PNG shows it instead of hiding it behind a good-looking page.
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      await cdp.send('Page.navigate', { url: pathToFileURL(svgPath).href });
      await sleep(700);
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 2 },
      });
      await writeFile(path.join(OUT, 'png', `${name}.${theme}.png`), Buffer.from(shot.data, 'base64'));
      done++;
      console.log(`ok   ${name}.${theme}  ${width}x${height}  svg ${(svg.length / 1024).toFixed(0)}KB`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}.${theme}  ${err.message}`);
    } finally {
      cdp.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {});
    }
  }
}
console.log(`\n${done} exported, ${failed} failed`);
chrome.kill();
process.exit(failed ? 1 : 0);
