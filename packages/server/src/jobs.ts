/**
 * The job host (J5-a, F-15): bots' schedules, webhooks and chat-app triggers,
 * in a process of their own, apart from the shared Husk that chats start.
 *
 * It mounts the TriggerHost the shared Husk used to, on a loopback port and a
 * token of its own, and runs nothing itself: a trigger that fires asks the
 * shared Husk to run the bot (remoteRunner). So one process owns every
 * computer, its holds and its take-overs, for chats and bots alike. The shared
 * Husk forwards the trigger routes to it (proxyTriggers), so a webhook keeps
 * its address, and starts it whenever a bot has a trigger (JobsLink).
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HUSK_VERSION, HuskError, ensurePaths, paths } from '@husk-ai/core';
import type { HuskErrorCode, HuskSpec, Logger, RunResult } from '@husk-ai/core';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { installBodyParsers } from './body.js';
import { installAuth } from './auth.js';
import { createContext } from './context.js';
import type { TriggerSync } from './context.js';
import { resolveDeps } from './deps.js';
import type { ServerDeps } from './deps.js';
import { installErrorHandling } from './errors.js';
import type { RunRequestBody, Runner, ServerRunEvent } from './runner.js';
import { createTriggerHost } from './triggers/index.js';

/** Where a running job host answers, in ~/.husk/jobs.json. */
export interface JobsRecord {
  url: string;
  token: string;
  pid: number;
  version: string;
  startedAt: string;
}

export function jobsFile(): string {
  return join(paths().root, 'jobs.json');
}

/** The record, or undefined when there is none or it cannot be read. */
export function readJobsRecord(): JobsRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(jobsFile(), 'utf8')) as Partial<JobsRecord>;
    return typeof r.url === 'string' && typeof r.token === 'string' && typeof r.pid === 'number' ? (r as JobsRecord) : undefined;
  } catch {
    return undefined;
  }
}

export function writeJobsRecord(record: JobsRecord): void {
  ensurePaths();
  const tmp = `${jobsFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, jobsFile());
}

/** Remove the record, but only if it is still this process's. */
export function clearJobsRecord(pid = process.pid): void {
  if (readJobsRecord()?.pid === pid) rmSync(jobsFile(), { force: true });
}

/** Whether a husk has a trigger the job host mounts: anything but `cli`. */
export function hasJobs(spec: HuskSpec): boolean {
  return spec.triggers.some((t) => t.type !== 'cli');
}

/** The shared Husk, as the job host reaches it. */
export interface SharedHusk {
  url: string;
  token: string | null;
}

/**
 * A runner that asks the shared Husk to run each bot: the `run` and `stream`
 * the TriggerHost calls, over the shared Husk's own run routes. `shared` finds
 * it, starting it if need be. Closing the request stops the run there.
 */
export function remoteRunner(shared: () => Promise<SharedHusk>): Pick<Runner, 'run' | 'stream'> {
  const call = async (spec: HuskSpec, path: string, body: RunRequestBody, signal?: AbortSignal): Promise<Response> => {
    const husk = await shared();
    const res = await fetch(`${husk.url}/v1/husks/${encodeURIComponent(spec.name)}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(husk.token ? { authorization: `Bearer ${husk.token}` } : {}) },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw fromBody((await res.json().catch(() => undefined)) as unknown, `the shared Husk answered ${res.status}`);
    return res;
  };
  return {
    async run(spec: HuskSpec, body: RunRequestBody, signal?: AbortSignal): Promise<RunResult> {
      return (await (await call(spec, 'run', body, signal)).json()) as RunResult;
    },
    async *stream(spec: HuskSpec, body: RunRequestBody, signal: AbortSignal): AsyncGenerator<ServerRunEvent> {
      yield* events(await call(spec, 'run/stream', body, signal));
    },
  };
}

/** A HuskError from an error body the shared Husk sent, or `fallback` for anything else. */
function fromBody(body: unknown, fallback: string): HuskError {
  const e = (body as { error?: { code?: string; message?: string; hint?: string } } | undefined)?.error;
  return new HuskError((e?.code ?? 'E_INTERNAL') as HuskErrorCode, e?.message ?? fallback, e?.hint ? { hint: e.hint } : {});
}

/** A run's events from an SSE body: one `data:` line each, until `event: done`; `event: error` throws. */
async function* events(res: Response): AsyncGenerator<ServerRunEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      let data: string | undefined;
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trimStart();
      }
      if (event === 'done') return;
      if (data === undefined) continue;
      const parsed = JSON.parse(data) as unknown;
      if (event === 'error') throw fromBody(parsed, 'the run failed in the shared Husk');
      yield parsed as ServerRunEvent;
    }
  }
}

/**
 * The job host's app: the husks' trigger routes and nothing else, behind a
 * token of its own, with every run asked of the shared Husk. `leave` runs
 * when a sync finds no husk with a trigger left to host, or when a Husk that
 * mounts the triggers itself asks (`POST /v1/shutdown`).
 */
export async function createJobsApp(opts: {
  deps: ServerDeps;
  runner: Pick<Runner, 'run' | 'stream'>;
  token: string;
  leave?: (why: string) => void;
}): Promise<FastifyInstance> {
  const deps = resolveDeps(opts.deps);
  await deps.store.init();
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024, trustProxy: false });
  // This process owns no computer: runs go to the shared Husk.
  app.decorate('husk', { ...createContext(deps), runner: opts.runner as Runner });
  installErrorHandling(app);
  installAuth(app, { token: opts.token, loopbackOnly: true });
  installBodyParsers(app);
  app.get('/health', async () => ({ ok: true, version: HUSK_VERSION, role: 'jobs' }));
  const host = createTriggerHost(app);
  const sync = async () => {
    const mounted = await host.sync();
    if (!mounted.length) opts.leave?.('no bot has a trigger');
    return mounted;
  };
  app.post('/v1/triggers/sync', async () => ({ triggers: await sync() }));
  app.post('/v1/shutdown', async () => {
    setImmediate(() => opts.leave?.('a Husk that mounts the triggers itself started'));
    return { ok: true };
  });
  await sync();
  host.start();
  await app.ready();
  return app;
}

/**
 * The shared Husk's side of the job host: it mounts no trigger of its own,
 * starts the job host whenever a bot has one, and tells it when husks change.
 */
export class JobsLink implements TriggerSync {
  private starting: Promise<JobsRecord | undefined> | undefined;

  constructor(
    private readonly opts: {
      start: () => void;
      store: { listHusks(): Promise<Array<{ name: string }>>; tryReadHusk(name: string): Promise<{ spec: HuskSpec } | undefined> };
      log: Logger;
    },
  ) {}

  /** The job host, if one answers. */
  async live(): Promise<JobsRecord | undefined> {
    const rec = readJobsRecord();
    if (!rec) return undefined;
    const ok = await fetch(`${rec.url}/health`, { headers: { authorization: `Bearer ${rec.token}` }, signal: AbortSignal.timeout(1500) }).then(
      (r) => r.ok,
      () => false,
    );
    return ok ? rec : undefined;
  }

  /** Whether any husk has a trigger for the job host. */
  async wanted(): Promise<boolean> {
    for (const summary of await this.opts.store.listHusks()) {
      const loaded = await this.opts.store.tryReadHusk(summary.name);
      if (loaded && hasJobs(loaded.spec)) return true;
    }
    return false;
  }

  /** The job host, started if a bot has a trigger and none answers. */
  async ensure(): Promise<JobsRecord | undefined> {
    const running = await this.live();
    if (running || !(await this.wanted())) return running;
    this.starting ??= (async () => {
      this.opts.start();
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const rec = await this.live();
        if (rec) return rec;
      }
      this.opts.log.error('the job host did not start; ~/.husk/jobs.log says why');
      return undefined;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** The husks changed: the job host reads them again, starting first if a bot now has a trigger. */
  async sync(): Promise<unknown> {
    const rec = await this.ensure();
    if (!rec) return [];
    return fetch(`${rec.url}/v1/triggers/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rec.token}` },
      signal: AbortSignal.timeout(30_000),
    }).then(
      (r) => r.json(),
      () => [],
    );
  }

  /** The job host outlives this Husk: a bot's schedule does not wait for a chat. */
  async stop(): Promise<void> {}
}

/**
 * Ask a running job host to leave. `husk serve` mounts the triggers itself,
 * and a job host left by a Husk a chat started would fire each one again.
 */
export async function dismissJobHost(): Promise<void> {
  const rec = readJobsRecord();
  if (!rec) return;
  await fetch(`${rec.url}/v1/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${rec.token}` }, signal: AbortSignal.timeout(2000) }).catch(
    () => undefined,
  );
}

/** Headers a hop sets for itself, and the shared Husk's own token, which the job host never sees. */
const HOP = new Set(['host', 'authorization', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'content-encoding', 'upgrade']);

/**
 * The trigger routes, forwarded to the job host, so an HTTP trigger, a webhook
 * or a chat app's callback keeps the shared Husk's address. The shared Husk's
 * own auth has run by now; the job host answers only it, by its token.
 */
export function proxyTriggers(app: FastifyInstance, link: JobsLink): void {
  const forward = async (req: FastifyRequest, reply: FastifyReply) => {
    const rec = await link.ensure();
    if (!rec) {
      if (req.url === '/v1/triggers') return { triggers: [], cron: [] };
      return reply.code(404).send({
        error: { code: 'E_HUSK_NOT_FOUND', message: `no trigger is mounted at ${req.url}`, hint: 'GET /v1/triggers lists what is mounted' },
      });
    }
    // A caller that goes away stops the run, through the job host and the shared Husk's run route.
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    const headers: Record<string, string> = { authorization: `Bearer ${rec.token}` };
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP.has(name)) headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    // An event stream may carry the shared Husk's token in the address (auth.ts): not passed on.
    const url = new URL(req.url, rec.url);
    url.searchParams.delete('token');
    url.searchParams.delete('access_token');
    const res = await fetch(url, {
      method: req.method,
      headers,
      ...(req.rawBody?.length && req.method !== 'GET' && req.method !== 'HEAD' ? { body: req.rawBody } : {}),
      signal: controller.signal,
    });
    for (const [name, value] of res.headers) if (!HOP.has(name)) void reply.header(name, value);
    return reply.code(res.status).send(res.body ? Readable.fromWeb(res.body as never) : '');
  };
  for (const path of ['/v1/t/*', '/v1/w/*', '/v1/a/*']) app.all(path, forward);
  app.get('/v1/triggers', forward);
}
