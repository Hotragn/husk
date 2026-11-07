#!/usr/bin/env node
// Start the packaged app (dist/*-unpacked) in smoke mode with a throwaway
// HUSK_HOME, and pass only if it started its bundled Husk and the console
// loaded. Runs the same on Windows, macOS and Linux (under xvfb-run there).
// A stand-in for Ollama answers on a free port, so the smoke can run a bot on
// the built-in engine in the Husk the app carries, with no model and no key.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const dirs = readdirSync(dist).filter((d) => /unpacked$|^mac/.test(d));
const candidates = dirs.flatMap((d) => [
  join(dist, d, 'Husk.exe'),
  join(dist, d, 'Husk.app', 'Contents', 'MacOS', 'Husk'),
  join(dist, d, 'husk-desktop'),
]);
const exe = candidates.find((p) => existsSync(p));
if (!exe) throw new Error(`no packaged app under ${dist} (looked in ${dirs.join(', ') || 'nothing'})`);

// Just enough of Ollama's API for the model router to find a model and get one answer.
const MODEL = 'qwen2.5:7b';
const ollama = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const json = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/api/tags') return json({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen2', parameter_size: '7.6B' } }] });
    if (req.url === '/api/show') return json({ capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32768 } });
    if (req.url === '/api/chat') {
      const said = { model: MODEL, message: { role: 'assistant', content: 'Hello from the stub model.' } };
      const counts = { done_reason: 'stop', prompt_eval_count: 12, eval_count: 6 };
      let stream = true;
      try {
        stream = JSON.parse(body).stream !== false;
      } catch {
        // not JSON: answer whole
      }
      if (!stream) return json({ ...said, done: true, ...counts });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ ...said, done: false })}\n${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, ...counts })}\n`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));

const home = mkdtempSync(join(tmpdir(), 'husk-desktop-smoke-'));
// The Husk and job host the app starts, read while it runs: on its way out the
// app asks its Husk to stop, and each record goes with its process.
const pids = new Set();
const watch = setInterval(() => {
  for (const name of ['daemon.json', 'jobs.json']) {
    try {
      const { pid } = JSON.parse(readFileSync(join(home, name), 'utf8'));
      if (typeof pid === 'number') pids.add(pid);
    } catch {
      // not written yet, or already gone
    }
  }
}, 250);
try {
  const env = { ...process.env, HUSK_HOME: home, HUSK_DESKTOP_SMOKE: '1', OLLAMA_HOST: `http://127.0.0.1:${ollama.address().port}` };
  // Not spawnSync: the stand-in Ollama answers from this process while the app runs.
  const app = spawn(exe, [], { env, stdio: 'ignore' });
  const killer = setTimeout(() => app.kill(), 120_000);
  const status = await new Promise((resolve) => app.on('exit', (code) => resolve(code)));
  clearTimeout(killer);
  const log = existsSync(join(home, 'desktop.log')) ? readFileSync(join(home, 'desktop.log'), 'utf8') : '';
  const daemon = existsSync(join(home, 'daemon.log')) ? readFileSync(join(home, 'daemon.log'), 'utf8') : '';
  console.log(`${exe}\nexit ${status}\n--- desktop.log\n${log}\n--- daemon.log\n${daemon}`);
  if (status !== 0 || !/SMOKE loaded Husk console/.test(log)) process.exitCode = 1;
} finally {
  clearInterval(watch);
  ollama.close();
  // Windows will not delete a folder a running process works in, and the
  // app's Husk works in this one. The app asks it to stop and exits without
  // waiting, and retries alone lost that race: wait for it, end it if it stays.
  await stopped(pids);
  await removed(home);
}

/** Deletes a folder, retrying while Windows lets go of it: rmSync's own retries skip EPERM. */
async function removed(dir, ms = 10_000) {
  for (const end = Date.now() + ms; ; ) {
    try {
      return rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Resolves once every pid has exited, ending any still running after `ms`. */
async function stopped(pids, ms = 15_000) {
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  };
  const end = Date.now() + ms;
  while ([...pids].some(alive) && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
  for (const pid of [...pids].filter(alive)) {
    console.log(`process ${pid} was still running ${ms / 1000}s after the app quit: ended it`);
    process.kill(pid);
  }
}
