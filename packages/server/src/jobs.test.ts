import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@husk-ai/core';
import type { HuskSpec, RunResult } from '@husk-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from './deps.js';
import { JobsLink, createJobsApp, dismissJobHost, readJobsRecord, remoteRunner, writeJobsRecord } from './jobs.js';
import type { JobsRecord } from './jobs.js';
import type { RunRequestBody, Runner } from './runner.js';
import type { Store } from './store.js';
import { FakeManager, FakeRouter, buildTestApp, fakeAgentFactory } from './testing.js';

const log = createLogger({ level: 'silent' });
// A bot with no tools and an HTTP trigger.
const hello = { name: 'hello', tools: [], triggers: [{ type: 'http', path: '/ask', auth: 'token' }] };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let home = '';
const open: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'husk-jobs-'));
  vi.stubEnv('HUSK_HOME', home);
});
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** A job host on a port of its own, over the same husks, running with `runner`. */
async function jobHost(store: Store, runner: Pick<Runner, 'run' | 'stream'>, leave?: (why: string) => void) {
  const token = 'jobs-token';
  const app = await createJobsApp({
    deps: { manager: new FakeManager(), router: new FakeRouter(), store, logger: log, config: resolveConfig({ host: '127.0.0.1', port: 0, token }) },
    runner,
    token,
    ...(leave ? { leave } : {}),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  open.push(() => app.close());
  const record: JobsRecord = { url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, token, pid: 1, version: 'test', startedAt: '' };
  return { app, record };
}

describe('the job host', { timeout: 30_000 }, () => {
  it('runs a trigger that fires by asking the shared Husk, whose run it is', async () => {
    const shared = await buildTestApp({ token: 'shared-token', agent: fakeAgentFactory({ text: 'ran in the shared Husk' }) });
    open.push(() => shared.cleanup());
    await shared.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(shared.app.server.address() as AddressInfo).port}`;
    await shared.app.inject({ method: 'POST', url: '/v1/husks', headers: bearer('shared-token'), payload: { spec: hello } });

    const jobs = await jobHost(shared.store, remoteRunner(async () => ({ url, token: 'shared-token' })));
    const fire = (headers: Record<string, string>) => jobs.app.inject({ method: 'POST', url: '/v1/t/hello/ask', headers, payload: { input: 'hi' } });
    expect((await fire({})).statusCode).toBe(401);
    const res = await fire(bearer('jobs-token'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: 'ran in the shared Husk', stopReason: 'complete' });
    // The shared Husk ran it: its own list of runs has it.
    expect(JSON.stringify((await shared.app.inject({ method: 'GET', url: '/v1/runs', headers: bearer('shared-token') })).json())).toContain('hello');

    // Streamed too: the shared Husk's events come through, then the end.
    const streamed = await fire({ ...bearer('jobs-token'), accept: 'text/event-stream' });
    expect(streamed.body).toContain('ran in the shared Husk');
    expect(streamed.body).toContain('event: done');
  });

  it('says when the shared Husk refuses a run, rather than answering for it', async () => {
    const shared = await buildTestApp({ token: 'shared-token' });
    open.push(() => shared.cleanup());
    await shared.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(shared.app.server.address() as AddressInfo).port}`;
    const runner = remoteRunner(async () => ({ url, token: 'wrong-token' }));
    await expect(runner.run({ name: 'hello' } as HuskSpec, { input: 'hi' })).rejects.toThrow();
  });

  it('leaves once no bot has a trigger, or when a Husk that mounts them itself asks', async () => {
    const shared = await buildTestApp({ token: 'shared-token' });
    open.push(() => shared.cleanup());
    const left: string[] = [];
    const jobs = await jobHost(shared.store, remoteRunner(async () => ({ url: 'http://127.0.0.1:9', token: null })), (why) => left.push(why));
    expect(left).toEqual(['no bot has a trigger']);
    writeJobsRecord(jobs.record);
    await dismissJobHost();
    await vi.waitFor(() => expect(left).toEqual(['no bot has a trigger', 'a Husk that mounts the triggers itself started']));
  });
});

describe('the Husk chats start', { timeout: 30_000 }, () => {
  it('mounts no trigger, starts the job host when a bot has one, and forwards the trigger routes to it', async () => {
    const asked: string[] = [];
    const answer: RunResult = { runId: 'run_x', text: 'from the job host', messages: [], steps: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 1, stopReason: 'complete' };
    const runner = {
      async run(spec: HuskSpec, body: RunRequestBody) {
        asked.push(`${spec.name}: ${String(body.input)}`);
        return answer;
      },
      async *stream() {
        return;
      },
    } as unknown as Pick<Runner, 'run' | 'stream'>;

    let record: JobsRecord | undefined;
    let started = 0;
    const shared = await buildTestApp({
      token: 'shared-token',
      // Starting the job host is a process in real life; here it is the one below, made known.
      jobs: (store) => new JobsLink({ start: () => (started++, record && writeJobsRecord(record)), store, log }),
    });
    open.push(() => shared.cleanup());
    record = (await jobHost(shared.store, runner)).record;
    expect(shared.app.husk.triggers).toBeInstanceOf(JobsLink);

    // No bot has a trigger yet: nothing is started, and nothing is mounted.
    expect((await shared.app.inject({ method: 'GET', url: '/v1/triggers', headers: bearer('shared-token') })).json()).toEqual({ triggers: [], cron: [] });
    expect(started).toBe(0);

    // Saving one starts the job host, which mounts it.
    await shared.app.inject({ method: 'POST', url: '/v1/husks', headers: bearer('shared-token'), payload: { spec: hello } });
    expect(started).toBe(1);
    expect(readJobsRecord()?.url).toBe(record.url);
    const mounted = (await shared.app.inject({ method: 'GET', url: '/v1/triggers', headers: bearer('shared-token') })).json();
    expect(mounted.triggers).toEqual([expect.objectContaining({ husk: 'hello', type: 'http', at: '/v1/t/hello/ask' })]);

    // The trigger keeps the shared Husk's address, and its own token.
    const fired = await shared.app.inject({ method: 'POST', url: '/v1/t/hello/ask', headers: bearer('shared-token'), payload: { input: 'hi' } });
    expect(fired.statusCode).toBe(200);
    expect(fired.json()).toMatchObject({ text: 'from the job host' });
    expect(asked).toEqual(['hello: hi']);
    expect((await shared.app.inject({ method: 'POST', url: '/v1/t/hello/ask', payload: { input: 'hi' } })).statusCode).toBe(401);
    expect((await shared.app.inject({ method: 'POST', url: '/v1/t/nowhere', headers: bearer('shared-token'), payload: { input: 'hi' } })).statusCode).toBe(404);
    expect(started).toBe(1);
  });

  it('never hands the job host its own token, in a header or in the address', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fake = createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: done\ndata: {}\n\n');
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    open.push(() => new Promise((r) => fake.close(r)));
    writeJobsRecord({ url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, token: 'jobs-token', pid: 1, version: 'test', startedAt: '' });
    const shared = await buildTestApp({ token: 'shared-token', jobs: (store) => new JobsLink({ start: () => undefined, store, log }) });
    open.push(() => shared.cleanup());

    // An event stream may only carry its token in the address.
    const res = await shared.app.inject({ method: 'GET', url: '/v1/t/hello/ask?input=hi&token=shared-token', headers: { accept: 'text/event-stream' } });
    expect(res.statusCode).toBe(200);
    expect(seen.find((s) => s.url.startsWith('/v1/t/'))).toEqual({ url: '/v1/t/hello/ask?input=hi', auth: 'Bearer jobs-token' });
    expect(JSON.stringify(seen)).not.toContain('shared-token');
  });
});
