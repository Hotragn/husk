import { HuskError } from '@husk/core';
import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, hostMatches, isHostAllowed, isPrivateHost, urlHost } from './net.js';

describe('hostMatches', () => {
  it('matches exactly, case- and trailing-dot-insensitively', () => {
    expect(hostMatches('Example.COM', 'example.com')).toBe(true);
    expect(hostMatches('example.com.', 'example.com')).toBe(true);
    expect(hostMatches('example.com', 'example.org')).toBe(false);
  });

  it('matches a leading wildcard against subdomains only', () => {
    expect(hostMatches('api.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('a.b.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('notexample.com', '*.example.com')).toBe(false);
  });

  it('treats a bare star as everything', () => {
    expect(hostMatches('anything.at.all', '*')).toBe(true);
  });
});

describe('isHostAllowed', () => {
  it('allows everything when there is no policy', () => {
    expect(isHostAllowed('example.com', undefined)).toBe(true);
  });

  it('refuses everything in none mode', () => {
    expect(isHostAllowed('example.com', { mode: 'none' })).toBe(false);
  });

  it('reads an empty egress allow-list as allowing nothing', () => {
    expect(isHostAllowed('example.com', { mode: 'egress' })).toBe(false);
    expect(isHostAllowed('example.com', { mode: 'egress', allow: [] })).toBe(false);
  });

  it('honours the egress allow-list', () => {
    const policy = { mode: 'egress' as const, allow: ['*.example.com', 'npmjs.org'] };
    expect(isHostAllowed('api.example.com', policy)).toBe(true);
    expect(isHostAllowed('npmjs.org', policy)).toBe(true);
    expect(isHostAllowed('evil.test', policy)).toBe(false);
  });

  it('applies deny even in full mode', () => {
    expect(isHostAllowed('evil.test', { mode: 'full', deny: ['evil.test'] })).toBe(false);
    expect(isHostAllowed('ok.test', { mode: 'full', deny: ['evil.test'] })).toBe(true);
  });

  it('lets deny beat allow', () => {
    const policy = { mode: 'egress' as const, allow: ['*.example.com'], deny: ['secret.example.com'] };
    expect(isHostAllowed('secret.example.com', policy)).toBe(false);
  });
});

describe('isPrivateHost', () => {
  it('spots loopback, link-local and RFC1918 space', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '169.254.169.254', '::1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it('leaves public addresses alone', () => {
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
});

describe('assertUrlAllowed', () => {
  const full = { mode: 'full' as const };

  it('returns a parsed URL for an allowed host', () => {
    expect(assertUrlAllowed('https://example.com/x', full).host).toBe('example.com');
  });

  it('refuses a non-http scheme', () => {
    expect(() => assertUrlAllowed('file:///etc/passwd', full)).toThrow(HuskError);
  });

  it('refuses a host outside the allow-list, with an actionable hint', () => {
    try {
      assertUrlAllowed('https://evil.test', { mode: 'egress', allow: ['example.com'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HuskError);
      expect((err as HuskError).code).toBe('E_EXEC_DENIED');
      expect((err as HuskError).hint).toContain('computer.network.allow');
    }
  });

  it('refuses the cloud metadata endpoint even in full mode', () => {
    expect(() => assertUrlAllowed('http://169.254.169.254/latest/meta-data/', full)).toThrow(/private address/);
  });

  it('permits a private host that the operator named explicitly', () => {
    const policy = { mode: 'egress' as const, allow: ['localhost'] };
    expect(assertUrlAllowed('http://localhost:8080/health', policy).port).toBe('8080');
  });
});

describe('urlHost', () => {
  it('returns null rather than throwing on junk', () => {
    expect(urlHost('not a url')).toBeNull();
    expect(urlHost('https://a.test/b')).toBe('a.test');
  });
});
