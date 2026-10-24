import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';
import type { ToolRunner } from './deps.js';

/**
 * A chat cancelling a call, or going away, stops the work the call started.
 *
 * Over a real port: `inject` never closes a socket. The bug this pins -- the
 * routes listened for the *request's* `close`, which fires once the body is
 * read -- only shows on one: attached after an `await` it never fired, so a
 * cancelled command ran on to its own timeout.
 */

let harness: TestApp;
afterEach(async () => {
  await harness?.cleanup();
});

/** True once `signal` aborts, false if it has not within `ms`. */
function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve(true)), { once: true });
  });
}

async function listen(runTool?: ToolRunner): Promise<{ base: string; id: string }> {
  harness = await buildTestApp(runTool ? { runTool } : {});
  await harness.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = harness.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
  return { base: `http://127.0.0.1:${addr.port}`, id };
}

const post = (url: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });

/** A POST given up on after `ms`, as a chat cancelling its call gives up on it. */
async function cancelledAfter(ms: number, url: string, body: unknown): Promise<void> {
  await post(url, body, AbortSignal.timeout(ms)).catch(() => undefined);
}

describe('a chat cancelling a tool call', { timeout: 30_000 }, () => {
  it('aborts the tool it is running', async () => {
    let seen: AbortSignal | undefined;
    const { base, id } = await listen(async (_c, _name, _args, signal) => {
      seen = signal;
      if (signal) await abortedWithin(signal, 10_000);
      return { content: [{ type: 'text', text: 'done' }] };
    });
    await cancelledAfter(300, `${base}/v1/computers/${id}/tools/shell`, { args: { command: 'sleep 99' } });
    expect(seen).toBeDefined();
    expect(await abortedWithin(seen!, 2_000)).toBe(true);
  });

  it('leaves a call that finished alone', async () => {
    let seen: AbortSignal | undefined;
    const { base, id } = await listen(async (_c, _name, _args, signal) => {
      seen = signal;
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const res = await post(`${base}/v1/computers/${id}/tools/shell`, { args: {} });
    expect(((await res.json()) as { content: Array<{ text: string }> }).content[0]?.text).toBe('done');
    // The response closing once it is sent is not a cancel.
    expect(await abortedWithin(seen!, 300)).toBe(false);
  });

  it('never runs a call cancelled while a person had the computer', async () => {
    const ran: string[] = [];
    const { base, id } = await listen(async (_c, name) => {
      ran.push(name);
      return { content: [{ type: 'text', text: 'ran' }] };
    });
    const { handoffId } = (await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover` })).json() as { handoffId: string };
    await cancelledAfter(300, `${base}/v1/computers/${id}/tools/shell`, { args: {} });
    await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done` });
    await new Promise((r) => setTimeout(r, 600));
    expect(ran).toEqual([]);
  });
});

describe('a client leaving POST /v1/computers/:id/exec', { timeout: 30_000 }, () => {
  it('aborts the command', async () => {
    const { base, id } = await listen();
    const computer = harness.manager.computers.get(id)!;
    let seen: AbortSignal | undefined;
    computer.exec = async (req) => {
      seen = req.signal;
      if (req.signal) await abortedWithin(req.signal, 10_000);
      return { exitCode: 124, stdout: '', stderr: '', durationMs: 1, truncated: false, timedOut: true };
    };
    await cancelledAfter(300, `${base}/v1/computers/${id}/exec`, { cmd: 'sleep 99', timeoutSec: 120 });
    expect(seen).toBeDefined();
    expect(await abortedWithin(seen!, 2_000)).toBe(true);
  });
});
