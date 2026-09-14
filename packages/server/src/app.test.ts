import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, fakeAgentFactory, sampleSpec } from './testing.js';
import type { TestApp } from './testing.js';

let harness: TestApp;

afterEach(async () => {
  await harness?.cleanup();
});

describe('health and doctor', () => {
  beforeEach(async () => {
    harness = await buildTestApp();
  });

  it('answers /health without auth', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, version: '0.1.0' });
    expect(res.json().uptimeSec).toBeTypeOf('number');
  });

  it('reports the honest state of the machine at /v1/doctor', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/v1/doctor' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe('0.1.0');
    expect(body.node).toBe(process.version);
    expect(body.providers[0]).toMatchObject({ name: 'local', available: true, isolated: false });
    expect(body.selection.provider).toBe('local');
    // Not isolated must be surfaced as a warning, not buried in a field.
    expect(body.warnings.join(' ')).toMatch(/not a sandbox/);
  });

  it('stamps the version header on every response', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-husk-version']).toBe('0.1.0');
  });
});

describe('error shape', () => {
  beforeEach(async () => {
    harness = await buildTestApp();
  });

  it('returns { error: { code, message, hint } } for an unknown route', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe('E_ROUTE_NOT_FOUND');
    expect(body.error.message).toContain('/v1/nope');
    expect(body.error.hint).toBeTruthy();
  });

  it('404s a missing computer with the documented code', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/v1/computers/cmp_missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'E_COMPUTER_NOT_FOUND', hint: 'run `husk ps` to list computers' });
  });

  it('404s a missing husk', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/v1/husks/ghost' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('E_HUSK_NOT_FOUND');
  });

  it('404s a missing run', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/v1/runs/run_ghost' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('E_RUN_NOT_FOUND');
  });

  it('422s an invalid husk spec', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: { spec: { name: 'Not A Valid Name!' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('E_SPEC_INVALID');
    expect(res.json().error.message).toContain('name');
  });

  it('422s an invalid computer spec, naming the offending field', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/computers',
      payload: { cpus: -4 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('cpus');
  });

  it('422s an unknown key rather than silently ignoring it', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: { memoryMB: 512 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('memoryMB');
  });

  it('400s malformed json with the standard body', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/computers',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('E_SPEC_INVALID');
  });
});

describe('auth', () => {
  it('lets everything through when no token is configured', async () => {
    harness = await buildTestApp();
    expect((await harness.app.inject({ method: 'GET', url: '/v1/computers' })).statusCode).toBe(200);
  });

  it('401s without a bearer token when one is set', async () => {
    harness = await buildTestApp({ token: 's3cret' });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/computers' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: 'E_NO_CREDENTIALS' });
    expect(res.json().error.message).toContain('missing Authorization');
  });

  it('401s on a wrong token, and says so', async () => {
    harness = await buildTestApp({ token: 's3cret' });
    const res = await harness.app.inject({
      method: 'GET',
      url: '/v1/computers',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toContain('not valid');
  });

  it('accepts the right token', async () => {
    harness = await buildTestApp({ token: 's3cret' });
    const res = await harness.app.inject({
      method: 'GET',
      url: '/v1/computers',
      headers: { authorization: 'Bearer s3cret' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('keeps /health unauthenticated', async () => {
    harness = await buildTestApp({ token: 's3cret' });
    expect((await harness.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('computers', () => {
  beforeEach(async () => {
    harness = await buildTestApp();
  });

  it('creates, lists, execs and destroys', async () => {
    const created = await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: { provider: 'local' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json()).toMatchObject({ provider: 'local', state: 'running', workdir: '/work' });

    const listed = await harness.app.inject({ method: 'GET', url: '/v1/computers' });
    expect(listed.json().computers).toHaveLength(1);

    const exec = await harness.app.inject({
      method: 'POST',
      url: `/v1/computers/${id}/exec`,
      payload: { cmd: 'uname -sr' },
    });
    expect(exec.statusCode).toBe(200);
    expect(exec.json()).toMatchObject({ exitCode: 0, truncated: false, timedOut: false });
    expect(exec.json().stdout).toContain('uname -sr');

    const removed = await harness.app.inject({ method: 'DELETE', url: `/v1/computers/${id}` });
    expect(removed.statusCode).toBe(204);
    expect((await harness.app.inject({ method: 'GET', url: `/v1/computers/${id}` })).statusCode).toBe(404);
  });

  it('stops and starts', async () => {
    const created = await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} });
    const id = created.json().id as string;
    expect((await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/stop` })).json().state).toBe('stopped');
    expect((await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/start` })).json().state).toBe('running');
  });

  it('rejects an exec with no command', async () => {
    const created = await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} });
    const id = created.json().id as string;
    const res = await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/exec`, payload: { cmd: '' } });
    expect(res.statusCode).toBe(422);
  });

  it('requires ?path on filesystem endpoints', async () => {
    const created = await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} });
    const id = created.json().id as string;
    const res = await harness.app.inject({ method: 'GET', url: `/v1/computers/${id}/fs` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('path');
  });

  it('round-trips a file through write and read', async () => {
    const created = await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} });
    const id = created.json().id as string;
    const write = await harness.app.inject({
      method: 'PUT',
      url: `/v1/computers/${id}/fs/write?path=/work/a.txt`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hello husk'),
    });
    expect(write.statusCode).toBe(204);
    const read = await harness.app.inject({ method: 'GET', url: `/v1/computers/${id}/fs/read?path=/work/a.txt` });
    expect(read.body).toBe('hello husk');
  });

  it('exposes a port', async () => {
    const created = await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} });
    const id = created.json().id as string;
    const res = await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/ports`, payload: { port: 8000 } });
    expect(res.json()).toMatchObject({ hostPort: 8000, url: 'http://127.0.0.1:8000' });
  });

  it('replays a response for a repeated Idempotency-Key', async () => {
    const headers = { 'idempotency-key': 'abc-123' };
    const first = await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {}, headers });
    const second = await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {}, headers });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
    expect(harness.manager.computers.size).toBe(1);
  });
});

describe('husks', () => {
  beforeEach(async () => {
    harness = await buildTestApp();
  });

  it('creates from a spec and reads it back with its yaml', async () => {
    const created = await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec() } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'triage', runCount: 0, triggers: ['cli'] });

    const read = await harness.app.inject({ method: 'GET', url: '/v1/husks/triage' });
    expect(read.json().spec.name).toBe('triage');
    expect(read.json().yaml).toContain('name: triage');
  });

  it('creates from yaml', async () => {
    const yaml = 'name: from-yaml\npersona: You are terse.\n';
    const created = await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { yaml } });
    expect(created.statusCode).toBe(201);
    const read = await harness.app.inject({ method: 'GET', url: '/v1/husks/from-yaml' });
    expect(read.json().spec.persona).toBe('You are terse.');
    // The yaml a human wrote is stored verbatim, not round-tripped through the parser.
    expect(read.json().yaml).toBe(yaml);
  });

  it('lists summaries', async () => {
    await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec('alpha') } });
    await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec('beta') } });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/husks' });
    expect(res.json().husks.map((h: { name: string }) => h.name)).toEqual(['alpha', 'beta']);
  });

  it('updates in place and rejects a renaming PUT', async () => {
    await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec() } });
    const ok = await harness.app.inject({
      method: 'PUT',
      url: '/v1/husks/triage',
      payload: { spec: { ...sampleSpec(), description: 'updated' } },
    });
    expect(ok.json().description).toBe('updated');

    const renamed = await harness.app.inject({
      method: 'PUT',
      url: '/v1/husks/triage',
      payload: { spec: sampleSpec('other') },
    });
    expect(renamed.statusCode).toBe(422);
    expect(renamed.json().error.message).toContain('does not match');
  });

  it('deletes', async () => {
    await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec() } });
    expect((await harness.app.inject({ method: 'DELETE', url: '/v1/husks/triage' })).statusCode).toBe(204);
    expect((await harness.app.inject({ method: 'DELETE', url: '/v1/husks/triage' })).statusCode).toBe(404);
  });

  it('validates without saving, reporting issues as data rather than a 422', async () => {
    const bad = await harness.app.inject({
      method: 'POST',
      url: '/v1/husks/validate',
      payload: { spec: { name: 'Bad Name' } },
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().ok).toBe(false);
    expect(bad.json().issues[0]).toContain('name');

    const good = await harness.app.inject({ method: 'POST', url: '/v1/husks/validate', payload: { spec: sampleSpec() } });
    expect(good.json()).toEqual({ ok: true });

    // Nothing was written by either call.
    expect((await harness.app.inject({ method: 'GET', url: '/v1/husks' })).json().husks).toHaveLength(0);
  });

  it('reports a yaml syntax error as an issue, not a stack trace', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/husks/validate',
      payload: { yaml: 'name: x\n\tbad: indentation' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().issues[0]).toMatch(/yaml/i);
  });
});

describe('running a husk', () => {
  beforeEach(async () => {
    harness = await buildTestApp();
    await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec() } });
  });

  it('runs and records the run', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'hi' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.text).toBe('done');
    expect(body.stopReason).toBe('complete');
    // The control plane's id, not the agent's -- so cancel and lookup work.
    expect(body.runId).not.toBe('agent_own_id');
    expect(body.runId).toMatch(/^run_/);

    const listed = await harness.app.inject({ method: 'GET', url: '/v1/runs' });
    expect(listed.json().runs[0]).toMatchObject({ runId: body.runId, husk: 'triage', status: 'complete' });

    const fetched = await harness.app.inject({ method: 'GET', url: `/v1/runs/${body.runId}` });
    expect(fetched.json().result.text).toBe('done');
    expect(fetched.json().events.some((e: { type: string }) => e.type === 'run_end')).toBe(true);
    // Every persisted event carries the control plane's id.
    const start = fetched.json().events.find((e: { type: string }) => e.type === 'run_start');
    expect(start.runId).toBe(body.runId);
  });

  it('bumps the husk run count', async () => {
    await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'hi' } });
    await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'again' } });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/husks' });
    expect(res.json().husks[0].runCount).toBe(2);
  });

  it('422s a run with no input', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('input');
  });

  it('404s a run against a husk that does not exist', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/v1/husks/ghost/run', payload: { input: 'hi' } });
    expect(res.statusCode).toBe(404);
  });

  it('streams SSE frames terminated by event: done', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/husks/triage/run/stream',
      payload: { input: 'hi' },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-accel-buffering']).toBe('no');
    const frames = res.body
      .split('\n\n')
      .filter((f) => f.startsWith('data:'))
      .map((f) => JSON.parse(f.replace(/^event: \w+\n/, '').slice('data: '.length)));
    expect(frames[0]).toMatchObject({ type: 'run_start' });
    expect(frames.some((f) => f.type === 'text_delta')).toBe(true);
    expect(res.body.trimEnd().endsWith('data: {}')).toBe(true);
    expect(res.body).toContain('event: done');
  });

  it('persists a failing run and surfaces the error shape', async () => {
    const failing = await buildTestApp({ agent: fakeAgentFactory({ fail: new Error('model exploded') }) });
    try {
      await failing.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec() } });
      const res = await failing.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'hi' } });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.message).toBe('model exploded');
      const listed = await failing.app.inject({ method: 'GET', url: '/v1/runs' });
      expect(listed.json().runs[0].status).toBe('error');
    } finally {
      await failing.cleanup();
    }
  });

  it('deletes a run', async () => {
    const run = await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'hi' } });
    const runId = run.json().runId as string;
    expect((await harness.app.inject({ method: 'DELETE', url: `/v1/runs/${runId}` })).statusCode).toBe(204);
    expect((await harness.app.inject({ method: 'GET', url: `/v1/runs/${runId}` })).statusCode).toBe(404);
    expect((await harness.app.inject({ method: 'GET', url: '/v1/runs' })).json().runs).toHaveLength(0);
  });

  it('202s a cancel for a run that already finished', async () => {
    const run = await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'hi' } });
    const res = await harness.app.inject({ method: 'POST', url: `/v1/runs/${run.json().runId}/cancel` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ cancelled: false, status: 'complete' });
  });

  it('cancels a run that is still in flight', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const slow = await buildTestApp({ agent: fakeAgentFactory({ hold }) });
    try {
      await slow.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec() } });
      const inflight = slow.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'hi' } });

      // Same reason as the approval poll: a fixed delay is a flake under load.
      let active = slow.app.husk.runner.listActive();
      for (let i = 0; i < 300 && active.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
        active = slow.app.husk.runner.listActive();
      }
      expect(active).toHaveLength(1);
      const cancel = await slow.app.inject({ method: 'POST', url: `/v1/runs/${active[0]!.runId}/cancel` });
      expect(cancel.statusCode).toBe(202);
      expect(cancel.json()).toMatchObject({ cancelled: true, status: 'aborted' });

      release();
      await inflight;
      const listed = await slow.app.inject({ method: 'GET', url: '/v1/runs' });
      expect(listed.json().runs[0].status).toBe('error');
    } finally {
      release();
      await slow.cleanup();
    }
  });

  it('paginates runs newest first', async () => {
    for (let i = 0; i < 5; i++) {
      await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: `run ${i}` } });
    }
    const first = await harness.app.inject({ method: 'GET', url: '/v1/runs?limit=2' });
    expect(first.json().runs).toHaveLength(2);
    expect(first.json().nextCursor).toBeTruthy();

    const second = await harness.app.inject({ method: 'GET', url: `/v1/runs?limit=2&cursor=${first.json().nextCursor}` });
    expect(second.json().runs).toHaveLength(2);
    const ids = [...first.json().runs, ...second.json().runs].map((r: { runId: string }) => r.runId);
    expect(new Set(ids).size).toBe(4);
  });

  it('filters runs by husk', async () => {
    await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec('other') } });
    await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'a' } });
    await harness.app.inject({ method: 'POST', url: '/v1/husks/other/run', payload: { input: 'b' } });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/runs?husk=other' });
    expect(res.json().runs).toHaveLength(1);
    expect(res.json().runs[0].husk).toBe('other');
  });
});

describe('approvals', () => {
  it('blocks on approval_required and resumes when answered', async () => {
    const call = { id: 'call_1', name: 'shell', args: { cmd: 'rm -rf /' } };
    harness = await buildTestApp({ agent: fakeAgentFactory({ approvalFor: call }) });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: { spec: { ...sampleSpec(), guardrails: { approvalMode: 'ask' } } },
    });

    const inflight = harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'go' } });

    // Poll rather than sleep a fixed amount: how long the agent takes to reach the
    // approval depends on how busy the machine is, and a hard-coded delay turns
    // that into a flake that only appears under load.
    let pending = await harness.app.inject({ method: 'GET', url: '/v1/approvals' });
    for (let i = 0; i < 300 && pending.json().approvals.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      pending = await harness.app.inject({ method: 'GET', url: '/v1/approvals' });
    }
    expect(pending.json().approvals).toHaveLength(1);
    const approvalId = pending.json().approvals[0].approvalId as string;
    expect(approvalId).toMatch(/^apr_/);
    expect(pending.json().approvals[0].call.name).toBe('shell');

    const answered = await harness.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}`,
      payload: { approve: true },
    });
    expect(answered.json()).toMatchObject({ approved: true });

    const result = await inflight;
    expect(result.statusCode).toBe(200);
    const events = (await harness.app.inject({ method: 'GET', url: `/v1/runs/${result.json().runId}` })).json().events;
    expect(events.some((e: { type: string }) => e.type === 'approval_required')).toBe(true);
    expect(events.some((e: { type: string }) => e.type === 'tool_start')).toBe(true);
  });

  it('denies by default when the approval is never answered', async () => {
    const call = { id: 'call_1', name: 'shell', args: { cmd: 'rm -rf /' } };
    harness = await buildTestApp({ agent: fakeAgentFactory({ approvalFor: call }), approvalTimeoutMs: 40 });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: { spec: { ...sampleSpec(), guardrails: { approvalMode: 'ask' } } },
    });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'go' } });
    const events = (await harness.app.inject({ method: 'GET', url: `/v1/runs/${res.json().runId}` })).json().events;
    expect(events.some((e: { type: string }) => e.type === 'tool_denied')).toBe(true);
  });

  it('404s an unknown approval id', async () => {
    harness = await buildTestApp();
    const res = await harness.app.inject({ method: 'POST', url: '/v1/approvals/apr_ghost', payload: { approve: true } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('E_APPROVAL_NOT_FOUND');
  });

  it('422s an approval answer that is not a boolean', async () => {
    harness = await buildTestApp();
    const res = await harness.app.inject({ method: 'POST', url: '/v1/approvals/apr_x', payload: { approve: 'yes' } });
    expect(res.statusCode).toBe(422);
  });
});

describe('models', () => {
  beforeEach(async () => {
    harness = await buildTestApp();
  });

  it('lists models and provider availability together', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.json().models[0]).toMatchObject({ id: 'fake/tiny', free: true });
    expect(res.json().providers[0]).toMatchObject({ id: 'fake', available: true });
  });

  it('proxies a chat request', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/models/chat',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.json()).toMatchObject({ text: 'fake reply', finishReason: 'stop' });
  });

  it('422s a chat request with no messages', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/v1/models/chat', payload: { model: 'auto', messages: [] } });
    expect(res.statusCode).toBe(422);
  });

  it('streams chat as SSE', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/models/chat/stream',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"type":"text_delta"');
    expect(res.body).toContain('event: done');
  });
});

describe('console fallback', () => {
  it('serves a build-me page when apps/console/dist is absent', async () => {
    harness = await buildTestApp();
    const res = await harness.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('npm run build --workspace=@husk/console');
    expect(res.body).toContain('/v1/doctor');
  });
});
