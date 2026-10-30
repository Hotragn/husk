import { describe, expect, it } from 'vitest';
import { assertBindIsSafe, bearerToken, isLoopbackHost } from './auth.js';
import { createApp } from './app.js';
import { FakeManager, FakeRouter, fakeAgentFactory, tempStore } from './testing.js';
import type { FastifyRequest } from 'fastify';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1', ''])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '192.168.1.10', '10.0.0.5', '::', 'example.com', '128.0.0.1'])(
    'treats %s as reachable from elsewhere',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

/**
 * The single most consequential default in this package. Binding a shell-execution
 * API to a LAN address with no token is not a warning-level mistake, so it has to
 * be a refusal that names the fix.
 */
describe('assertBindIsSafe', () => {
  it('allows loopback without a token', () => {
    expect(() => assertBindIsSafe('127.0.0.1', undefined)).not.toThrow();
  });

  it('allows any host once a token is set', () => {
    expect(() => assertBindIsSafe('0.0.0.0', 'a-real-token')).not.toThrow();
  });

  it('refuses a non-loopback bind with no token', () => {
    expect(() => assertBindIsSafe('0.0.0.0', undefined)).toThrow(/refusing to bind/);
  });

  it('puts the fix in the hint, not just the message', () => {
    try {
      assertBindIsSafe('0.0.0.0', undefined);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_CONFIG');
      expect((err as { hint: string }).hint).toContain('HUSK_TOKEN');
      expect((err as { hint: string }).hint).toContain('--host 0.0.0.0');
    }
  });

  it('refuses at construction, before a socket is ever opened', async () => {
    const { store, cleanup } = await tempStore();
    try {
      await expect(
        createApp({
          manager: new FakeManager(),
          router: new FakeRouter(),
          store,
          agentFactory: fakeAgentFactory(),
          config: { host: '0.0.0.0', port: 0, triggers: false },
        }),
      ).rejects.toMatchObject({ code: 'E_CONFIG' });
    } finally {
      await store.close();
      await cleanup();
    }
  });
});

describe('bearerToken', () => {
  const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} }) as FastifyRequest;

  it('reads a bearer token', () => {
    expect(bearerToken(req('Bearer abc123'))).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(bearerToken(req('bearer abc123'))).toBe('abc123');
  });

  it('trims surrounding whitespace', () => {
    expect(bearerToken(req('  Bearer   abc123  '))).toBe('abc123');
  });

  it('returns undefined for another scheme or no header', () => {
    expect(bearerToken(req('Basic abc123'))).toBeUndefined();
    expect(bearerToken(req())).toBeUndefined();
  });
});

describe('DNS rebinding, with no token', () => {
  it('answers loopback names and refuses any other Host', async () => {
    const { buildTestApp } = await import('./testing.js');
    const harness = await buildTestApp();
    try {
      for (const host of ['localhost:7377', '127.0.0.1:7377', '[::1]:7377', 'localhost']) {
        const ok = await harness.app.inject({ method: 'GET', url: '/v1/handoffs', headers: { host } });
        expect(ok.statusCode, host).toBe(200);
      }
      for (const host of ['evil.example', 'evil.example:7377', '127.0.0.1.evil.example', '192.168.1.10:7377']) {
        const res = await harness.app.inject({ method: 'GET', url: '/v1/handoffs', headers: { host } });
        expect(res.statusCode, host).toBe(401);
        expect(res.json().error.hint).toMatch(/HUSK_TOKEN/);
      }
    } finally {
      await harness.cleanup();
    }
  });

  it('leaves Host alone on a non-loopback bind with a token, where the token is the defence', async () => {
    const { buildTestApp } = await import('./testing.js');
    const harness = await buildTestApp({ token: 'test-token-0123456789', host: '0.0.0.0' });
    try {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/v1/handoffs',
        headers: { host: 'husk.example.com', authorization: 'Bearer test-token-0123456789' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });
});

describe('the console page behind a token', () => {
  it('loads without the token, while every API route still needs it', async () => {
    const { buildTestApp } = await import('./testing.js');
    const harness = await buildTestApp({ token: 'server-token' });
    try {
      // No console bundle in tests, so the page is a 404 -- but not a 401.
      expect((await harness.app.inject({ method: 'GET', url: '/' })).statusCode).not.toBe(401);
      expect((await harness.app.inject({ method: 'GET', url: '/assets/index.js' })).statusCode).not.toBe(401);
      expect((await harness.app.inject({ method: 'GET', url: '/v1/computers' })).statusCode).toBe(401);
      expect((await harness.app.inject({ method: 'POST', url: '/', payload: {} })).statusCode).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });
});

describe('the token cannot be walked around', () => {
  it('refuses a percent-encoded /v1 path, which the router decodes', async () => {
    const { buildTestApp } = await import('./testing.js');
    const harness = await buildTestApp({ token: 'server-token' });
    try {
      for (const url of ['/%761/computers', '/%76%31/computers', '/v%31/computers', '/%76%31/overview']) {
        expect((await harness.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      }
    } finally {
      await harness.cleanup();
    }
  });

  it('refuses a request from another website, even with a valid token', async () => {
    const { buildTestApp } = await import('./testing.js');
    const harness = await buildTestApp({ token: 'server-token' });
    try {
      const auth = { authorization: 'Bearer server-token' };
      expect((await harness.app.inject({ method: 'GET', url: '/v1/computers', headers: { ...auth, origin: 'https://evil.example' } })).statusCode).toBe(403);
      expect((await harness.app.inject({ method: 'GET', url: '/v1/computers', headers: { ...auth, origin: 'http://127.0.0.1:7377' } })).statusCode).toBe(200);
      expect((await harness.app.inject({ method: 'GET', url: '/v1/computers', headers: { ...auth, origin: 'http://localhost:5173' } })).statusCode).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  it('answers only loopback names on a loopback bind, token or not', async () => {
    const { buildTestApp } = await import('./testing.js');
    const harness = await buildTestApp({ token: 'server-token' });
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/v1/computers', headers: { authorization: 'Bearer server-token', host: 'evil.example' } });
      expect(res.statusCode).toBe(403);
    } finally {
      await harness.cleanup();
    }
  });
});
