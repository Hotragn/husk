import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CronScheduler } from '../cron.js';
import { buildTestApp, sampleSpec } from '../testing.js';
import type { TestApp } from '../testing.js';
import { CronBindings } from './cron.js';
import { extractInput, mountKey } from './http.js';
import { hmacHex, safeCompareHex, verifyHmacSignature } from './webhook.js';
import type { FastifyRequest } from 'fastify';

let harness: TestApp;

afterEach(async () => {
  await harness?.cleanup();
});

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('webhook signatures', () => {
  const secret = 'shhh';
  const body = '{"input":"deploy the thing"}';

  it('accepts a correct signature', () => {
    expect(verifyHmacSignature({ secret, rawBody: body, signature: sign(secret, body) })).toEqual({ ok: true });
  });

  it('accepts a bare hex signature without the sha256= prefix', () => {
    expect(verifyHmacSignature({ secret, rawBody: body, signature: hmacHex(secret, body) }).ok).toBe(true);
  });

  it('rejects a signature over different bytes', () => {
    const forged = sign(secret, '{"input":"rm -rf /"}');
    expect(verifyHmacSignature({ secret, rawBody: body, signature: forged })).toMatchObject({
      ok: false,
      reason: 'signature does not match',
    });
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyHmacSignature({ secret, rawBody: body, signature: sign('other', body) }).ok).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyHmacSignature({ secret, rawBody: body, signature: undefined })).toMatchObject({
      ok: false,
      reason: 'missing signature header',
    });
  });

  it('rejects a truncated signature rather than matching on a prefix', () => {
    const full = hmacHex(secret, body);
    expect(verifyHmacSignature({ secret, rawBody: body, signature: full.slice(0, 40) }).ok).toBe(false);
  });

  it('is byte-exact: whitespace changes the signature', () => {
    const spaced = `${body} `;
    expect(verifyHmacSignature({ secret, rawBody: spaced, signature: sign(secret, body) }).ok).toBe(false);
  });

  it('binds a timestamp when a tolerance is set', () => {
    const nowSec = 1_700_000_000;
    const now = () => nowSec * 1000;
    const ts = String(nowSec);
    const signature = `sha256=${hmacHex(secret, `${ts}.${body}`)}`;

    expect(verifyHmacSignature({ secret, rawBody: body, signature, timestamp: ts, toleranceSec: 300, now }).ok).toBe(true);

    const stale = String(nowSec - 600);
    const staleSig = `sha256=${hmacHex(secret, `${stale}.${body}`)}`;
    expect(
      verifyHmacSignature({ secret, rawBody: body, signature: staleSig, timestamp: stale, toleranceSec: 300, now }),
    ).toMatchObject({ ok: false, reason: 'timestamp outside the replay window' });
  });

  it('requires a timestamp once a tolerance is set', () => {
    expect(
      verifyHmacSignature({ secret, rawBody: body, signature: sign(secret, body), toleranceSec: 300 }),
    ).toMatchObject({ ok: false, reason: 'missing timestamp header' });
  });
});

describe('safeCompareHex', () => {
  it('matches identical digests and rejects everything else', () => {
    const a = hmacHex('k', 'x');
    expect(safeCompareHex(a, a)).toBe(true);
    expect(safeCompareHex(a, a.toUpperCase())).toBe(true);
    expect(safeCompareHex(a, hmacHex('k', 'y'))).toBe(false);
    expect(safeCompareHex(a, a.slice(0, -2))).toBe(false);
    expect(safeCompareHex('', '')).toBe(false);
  });
});

describe('mountKey', () => {
  it('normalises a trigger path into an exact lookup key', () => {
    expect(mountKey('triage', '/')).toBe('/triage');
    expect(mountKey('triage', '')).toBe('/triage');
    expect(mountKey('triage', 'hook')).toBe('/triage/hook');
    expect(mountKey('triage', '/hook/')).toBe('/triage/hook');
  });
});

describe('extractInput', () => {
  const req = (body: unknown, query: Record<string, string> = {}) => ({ body, query }) as unknown as FastifyRequest;

  it('reads the documented field first', () => {
    expect(extractInput(req({ input: 'a', text: 'b' }))).toBe('a');
  });

  it('accepts the shapes senders actually use', () => {
    expect(extractInput(req({ text: 'from text' }))).toBe('from text');
    expect(extractInput(req({ message: 'from message' }))).toBe('from message');
    expect(extractInput(req({ prompt: 'from prompt' }))).toBe('from prompt');
  });

  it('reads a raw text body', () => {
    expect(extractInput(req('just a string'))).toBe('just a string');
    expect(extractInput(req(Buffer.from('from bytes')))).toBe('from bytes');
  });

  it('reads the query string', () => {
    expect(extractInput(req(undefined, { input: 'from query' }))).toBe('from query');
  });

  it('hands over an unrecognised payload whole rather than dropping the event', () => {
    expect(extractInput(req({ alertname: 'DiskFull', severity: 'page' }))).toBe(
      '{"alertname":"DiskFull","severity":"page"}',
    );
  });

  it('returns undefined when there is genuinely nothing', () => {
    expect(extractInput(req(undefined))).toBeUndefined();
    expect(extractInput(req({}))).toBeUndefined();
    expect(extractInput(req('   '))).toBeUndefined();
  });
});

describe('CronBindings', () => {
  const clock = new Date(2025, 5, 10, 8, 30);

  it('keys jobs by husk and schedule, and leaves an unchanged job alone', () => {
    const scheduler = new CronScheduler({ now: () => clock });
    const fired: string[] = [];
    const bindings = new CronBindings(scheduler, (husk) => void fired.push(husk));

    const first = bindings.add('triage', '0 9 * * *', 'check the queue');
    const again = bindings.add('triage', '0 9 * * *', 'check the queue');
    expect(again.jobId).toBe(first.jobId);
    expect(scheduler.size).toBe(1);
    expect(first.nextAt).toBe(new Date(2025, 5, 10, 9, 0).toISOString());
  });

  it('updates the prompt without resetting the countdown', () => {
    const scheduler = new CronScheduler({ now: () => clock });
    const seen: string[] = [];
    const bindings = new CronBindings(scheduler, (_h, prompt) => void seen.push(prompt));
    bindings.add('triage', '0 9 * * *', 'old prompt');
    bindings.add('triage', '0 9 * * *', 'new prompt');
    scheduler.fireDue(new Date(2025, 5, 10, 9, 0));
    expect(seen).toEqual(['new prompt']);
  });

  it('drops jobs that are no longer declared', () => {
    const scheduler = new CronScheduler({ now: () => clock });
    const bindings = new CronBindings(scheduler, () => undefined);
    const keep = bindings.add('a', '0 9 * * *', 'x');
    bindings.add('b', '0 10 * * *', 'y');
    expect(scheduler.size).toBe(2);

    const removed = bindings.retain(new Set([keep.jobId]));
    expect(removed).toHaveLength(1);
    expect(scheduler.size).toBe(1);
    expect(bindings.list().map((b) => b.husk)).toEqual(['a']);
  });

  it('throws on an invalid schedule at bind time', () => {
    const bindings = new CronBindings(new CronScheduler(), () => undefined);
    expect(() => bindings.add('bad', 'every tuesday', 'x')).toThrow(/invalid cron expression/);
  });
});

// Every test here stands a real Fastify app up and writes a husk to disk. That
// is several hundred ms on an idle machine and multiples of it in a full
// parallel run, which is how this suite started failing on vitest's 5s default
// for reasons unrelated to triggers. The budget matches what the tests do.
describe('mounted triggers', { timeout: 30_000 }, () => {
  it('serves an http trigger at its declared path', async () => {
    harness = await buildTestApp({ triggers: true });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: { spec: { ...sampleSpec('triage'), triggers: [{ type: 'http', path: '/ask', auth: 'none' }] } },
    });

    const res = await harness.app.inject({ method: 'POST', url: '/v1/t/triage/ask', payload: { input: 'hello' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: 'done', stopReason: 'complete' });
    expect(res.json().runId).toMatch(/^run_/);
  });

  it('404s a path no husk declared', async () => {
    harness = await buildTestApp({ triggers: true });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/t/nobody/here', payload: { input: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('E_HUSK_NOT_FOUND');
  });

  it('422s an http trigger request with no prompt in it', async () => {
    harness = await buildTestApp({ triggers: true });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: { spec: { ...sampleSpec(), triggers: [{ type: 'http', path: '/' }] } },
    });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/t/triage', payload: {} });
    expect(res.statusCode).toBe(422);
  });

  it('stops answering as soon as the husk is deleted', async () => {
    harness = await buildTestApp({ triggers: true });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: { spec: { ...sampleSpec(), triggers: [{ type: 'http', path: '/' }] } },
    });
    expect((await harness.app.inject({ method: 'POST', url: '/v1/t/triage', payload: { input: 'x' } })).statusCode).toBe(
      200,
    );
    await harness.app.inject({ method: 'DELETE', url: '/v1/husks/triage' });
    expect((await harness.app.inject({ method: 'POST', url: '/v1/t/triage', payload: { input: 'x' } })).statusCode).toBe(
      404,
    );
  });

  it('verifies the hmac on a webhook trigger', async () => {
    harness = await buildTestApp({ triggers: true });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: { spec: { ...sampleSpec(), triggers: [{ type: 'webhook', path: '/hook', secret: 'shhh' }] } },
    });

    const body = JSON.stringify({ input: 'ship it' });
    const good = await harness.app.inject({
      method: 'POST',
      url: '/v1/w/triage/hook',
      headers: { 'content-type': 'application/json', 'x-husk-signature': sign('shhh', body) },
      payload: body,
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().text).toBe('done');

    const unsigned = await harness.app.inject({
      method: 'POST',
      url: '/v1/w/triage/hook',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(403);
    expect(unsigned.json().error).toMatchObject({ code: 'E_EXEC_DENIED' });

    const forged = await harness.app.inject({
      method: 'POST',
      url: '/v1/w/triage/hook',
      headers: { 'content-type': 'application/json', 'x-husk-signature': sign('wrong', body) },
      payload: body,
    });
    expect(forged.statusCode).toBe(403);
  });

  it('signs over the exact bytes received, not a re-serialised object', async () => {
    harness = await buildTestApp({ triggers: true });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: { spec: { ...sampleSpec(), triggers: [{ type: 'webhook', path: '/hook', secret: 'shhh' }] } },
    });
    // Whitespace and key order that JSON.stringify would not reproduce.
    const body = '{\n  "message" : "hi",\n  "input": "go"\n}';
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/w/triage/hook',
      headers: { 'content-type': 'application/json', 'x-husk-signature': sign('shhh', body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });

  it('lists what is mounted, and flags an unsigned webhook', async () => {
    harness = await buildTestApp({ triggers: true });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: {
        spec: {
          ...sampleSpec(),
          triggers: [
            { type: 'http', path: '/ask' },
            { type: 'webhook', path: '/open' },
            { type: 'cron', schedule: '0 9 * * *', prompt: 'daily' },
          ],
        },
      },
    });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/triggers' });
    const triggers = res.json().triggers as Array<{ type: string; at: string; detail: string }>;
    expect(triggers.map((t) => t.type).sort()).toEqual(['cron', 'http', 'webhook']);
    expect(triggers.find((t) => t.type === 'webhook')!.detail).toContain('UNSIGNED');
    expect(triggers.find((t) => t.type === 'cron')!.detail).toMatch(/^next 20/);
    expect(res.json().cron).toHaveLength(1);
  });

  it('disables one bad cron schedule without taking the other triggers down', async () => {
    harness = await buildTestApp({ triggers: true });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/husks',
      payload: {
        spec: {
          ...sampleSpec(),
          triggers: [
            { type: 'cron', schedule: 'not a schedule', prompt: 'x' },
            { type: 'http', path: '/ask' },
          ],
        },
      },
    });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/triggers' });
    expect(res.json().triggers.map((t: { type: string }) => t.type)).toEqual(['http']);
    expect((await harness.app.inject({ method: 'POST', url: '/v1/t/triage/ask', payload: { input: 'x' } })).statusCode).toBe(
      200,
    );
  });
});
