import { afterEach, describe, expect, it } from 'vitest';
import { ctxOf } from '../context.js';
import { buildTestApp } from '../testing.js';
import type { TestApp } from '../testing.js';

const TOKEN = 'server-token-for-the-test';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('signing in to the console with a one-time code', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
  });

  it('mints a code only for the server token, and trades it for the token once', async () => {
    t = await buildTestApp({ token: TOKEN });
    expect((await t.app.inject({ method: 'POST', url: '/v1/console/link' })).statusCode).toBe(401);

    const minted = await t.app.inject({ method: 'POST', url: '/v1/console/link', headers: bearer(TOKEN) });
    expect(minted.statusCode).toBe(200);
    const { code } = minted.json() as { code: string };
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(code).not.toBe(TOKEN);

    const first = await t.app.inject({ method: 'POST', url: '/v1/scoped/console', headers: bearer(code) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ token: TOKEN });
    expect(first.headers['cache-control']).toBe('no-store');

    const again = await t.app.inject({ method: 'POST', url: '/v1/scoped/console', headers: bearer(code) });
    expect(again.statusCode).toBe(401);
    expect((again.json() as { error: { code: string } }).error.code).toBe('E_NO_CREDENTIALS');
  });

  it('opens nothing else, and takes no other kind of token', async () => {
    t = await buildTestApp({ token: TOKEN });
    const { code } = (await t.app.inject({ method: 'POST', url: '/v1/console/link', headers: bearer(TOKEN) })).json() as { code: string };
    // A sign-in code is not the server token anywhere else.
    expect((await t.app.inject({ method: 'GET', url: '/v1/computers', headers: bearer(code) })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/v1/console/link', headers: bearer(code) })).statusCode).toBe(401);
    // It shares the /v1/scoped/ prefix with a computer's link, and opens no computer.
    expect((await t.app.inject({ method: 'GET', url: '/v1/scoped/computer', headers: bearer(code) })).statusCode).toBe(404);
    // A computer link's token cannot be traded for the server token.
    const link = ctxOf(t.app).scoped.mint('computer:cmp_1');
    expect((await t.app.inject({ method: 'POST', url: '/v1/scoped/console', headers: bearer(link) })).statusCode).toBe(401);
    // Nor can the server token itself, which has nothing to trade.
    expect((await t.app.inject({ method: 'POST', url: '/v1/scoped/console', headers: bearer(TOKEN) })).statusCode).toBe(401);
    // The code was not spent by any of that.
    expect((await t.app.inject({ method: 'POST', url: '/v1/scoped/console', headers: bearer(code) })).json()).toEqual({ token: TOKEN });
  });
});
