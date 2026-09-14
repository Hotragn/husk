/**
 * `computerId` on the run body.
 *
 * It was declared in the SDK types, documented in the API reference, and never
 * read -- and the stated reason was that the agent addresses machines by a
 * stable key rather than by id, so honouring it would mean widening a
 * `@husk/agent` contract. That was wrong twice: `ComputerSource` has one
 * method, and a source that answers every key with one machine satisfies it.
 *
 * A field that is accepted and does nothing is worse than one that errors,
 * because the run appears to succeed against the wrong machine.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, FakeComputer, sampleSpec } from '../testing.js';
import type { TestApp } from '../testing.js';

describe('pinning a run to an existing computer', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await buildTestApp();
    await ctx.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec: sampleSpec('triage') } });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('404s for an id that does not exist, before spending a token', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/husks/triage/run',
      payload: { input: 'hello', computerId: 'nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('nope');
  });

  it('accepts a run against a computer that does exist', async () => {
    ctx.manager.computers.set('pinned-1', new FakeComputer('pinned-1'));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/husks/triage/run',
      payload: { input: 'hello', computerId: 'pinned-1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('still runs with no computerId at all', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/husks/triage/run', payload: { input: 'hello' } });
    expect(res.statusCode).toBe(200);
  });
});
