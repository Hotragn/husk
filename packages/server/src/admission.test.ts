import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMISSION_EXEMPT } from './app.js';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

/**
 * Take-over applies on every route that changes a computer.
 *
 * The route table is read from the route sources, so a route added later is
 * checked here without anyone remembering to list it: while a person holds
 * the computer, a program's change is refused with E_COMPUTER_HELD, and the
 * console's own buttons, which act as the person, go through.
 */

const routesDir = join(dirname(fileURLToPath(import.meta.url)), 'routes');
const CHANGES = /app\.(post|put|patch|delete)\(\s*'(\/v1\/computers\/:id[^']*)'/g;

function changingRoutes(): Array<{ method: string; path: string }> {
  const found = new Map<string, { method: string; path: string }>();
  for (const file of readdirSync(routesDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    for (const m of readFileSync(join(routesDir, file), 'utf8').matchAll(CHANGES)) {
      const route = { method: m[1]!.toUpperCase(), path: m[2]! };
      found.set(`${route.method} ${route.path}`, route);
    }
  }
  return [...found.values()];
}

let harness: TestApp;
afterEach(async () => {
  await harness?.cleanup();
});

async function held(): Promise<string> {
  harness = await buildTestApp();
  const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
  expect((await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover` })).statusCode).toBe(201);
  return id;
}

const call = (method: string, path: string, id: string, headers: Record<string, string> = {}) =>
  harness.app.inject({
    method: method as 'POST',
    url: path.replace(':id', id).replace(':name', 'shell'),
    headers,
    ...(method === 'DELETE' ? {} : { payload: {} }),
  });

describe('a computer a person holds', { timeout: 30_000 }, () => {
  it('refuses a program’s change on every route that makes one', async () => {
    const id = await held();
    const routes = changingRoutes().filter((r) => !ADMISSION_EXEMPT.has(`${r.method} ${r.path}`));
    expect(routes.length).toBeGreaterThan(10);
    for (const { method, path } of routes) {
      const res = await call(method, path, id);
      expect({ route: `${method} ${path}`, status: res.statusCode, code: res.json().error?.code }).toEqual({
        route: `${method} ${path}`,
        status: 409,
        code: 'E_COMPUTER_HELD',
      });
    }
  });

  it('lets the console’s own buttons through, since they act as the person', async () => {
    const id = await held();
    for (const { method, path } of changingRoutes()) {
      if (method === 'DELETE' && path === '/v1/computers/:id') continue;
      const res = await call(method, path, id, { 'x-husk-as': 'person' });
      expect({ route: `${method} ${path}`, held: res.statusCode === 409 }).toEqual({ route: `${method} ${path}`, held: false });
    }
  });

  it('names its exemptions, and each is a real route', () => {
    const real = new Set(changingRoutes().map((r) => `${r.method} ${r.path}`));
    for (const route of ADMISSION_EXEMPT) expect(real.has(route), route).toBe(true);
  });

  it('says who holds it, and when to try again', async () => {
    const id = await held();
    const body = (await call('POST', '/v1/computers/:id/exec', id)).json() as { error: { message: string; hint: string } };
    expect(body.error.message).toContain('took over this computer');
    expect(body.error.hint).toContain('give it back');
  });

  it('takes changes again once it is given back', async () => {
    harness = await buildTestApp();
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    const { handoffId } = (await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover` })).json() as { handoffId: string };
    await harness.app.inject({ method: 'POST', url: `/v1/handoffs/${handoffId}/done`, headers: { 'x-husk-as': 'person' } });
    expect((await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/exec`, payload: { cmd: 'echo hi' } })).statusCode).toBe(200);
  });
});

describe('a program’s exec running when a person takes over', { timeout: 30_000 }, () => {
  it('is stopped, and the take-over answers once it has', async () => {
    harness = await buildTestApp();
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    let stopped = false;
    harness.manager.computers.get(id)!.exec = async (req) => {
      await new Promise<void>((r) => req.signal?.addEventListener('abort', () => r(), { once: true }));
      stopped = true;
      return { exitCode: 124, stdout: '', stderr: '', durationMs: 1, truncated: false, timedOut: true };
    };
    const running = harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/exec`, payload: { cmd: 'sleep 99' } });
    await new Promise((r) => setTimeout(r, 200));
    await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/takeover` });
    expect(stopped).toBe(true);
    expect((await running).json()).toMatchObject({ timedOut: true });
  });
});
