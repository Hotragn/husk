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
