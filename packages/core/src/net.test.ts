import { describe, expect, it } from 'vitest';
import {
  assertUrlAllowed,
  hostMatches,
  isHostAllowed,
  isInternalHost,
  isLoopbackHost,
  networkEnforcement,
  urlHost,
} from './net.js';

/**
 * This file is the reason the implementation moved into core.
 *
 * Three copies of these rules existed and they had drifted on whether
 * `mode: 'full'` can reach the cloud metadata endpoint. A security check with
 * two answers is not a check, so the answers live here.
 */

describe('hostMatches', () => {
  it('matches exactly, case-insensitively, ignoring a trailing dot', () => {
    expect(hostMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(hostMatches('API.Example.COM', 'api.example.com')).toBe(true);
    expect(hostMatches('api.example.com.', 'api.example.com')).toBe(true);
  });

  it('supports a single leading wildcard label', () => {
    expect(hostMatches('api.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('deep.api.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
  });

  it('does not let a shared prefix pass as a subdomain', () => {
    // The classic bug: `evil-example.com`.endsWith('example.com') is true.
    expect(hostMatches('evil-example.com', '*.example.com')).toBe(false);
    expect(hostMatches('notexample.com', '*.example.com')).toBe(false);
  });

  it('treats a bare star as everything', () => {
    expect(hostMatches('anything.at.all', '*')).toBe(true);
  });
});

describe('isInternalHost', () => {
  const internal = [
    '169.254.169.254',
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    'localhost',
    'foo.localhost',
    'printer.local',
    'db.internal',
    'metadata.google.internal',
    '::1',
    'fe80::1',
    'fd00::1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '100.64.0.1',
  ];
  for (const h of internal) {
    it(`${h} is internal`, () => expect(isInternalHost(h)).toBe(true));
  }

  const external = ['example.com', '8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '11.0.0.1', '99.1.1.1'];
  for (const h of external) {
    it(`${h} is external`, () => expect(isInternalHost(h)).toBe(false));
  }

  it('is not fooled by a bracketed IPv6 literal', () => {
    expect(isInternalHost('[::1]')).toBe(true);
  });
});

describe('isHostAllowed', () => {
  it('mode none allows nothing', () => {
    expect(isHostAllowed('example.com', { mode: 'none' })).toBe(false);
  });

  it('mode egress with no allow-list allows nothing', () => {
    // Reading an empty list as "unrestricted" would be the dangerous choice.
    expect(isHostAllowed('example.com', { mode: 'egress' })).toBe(false);
  });

  it('mode egress honours the allow-list', () => {
    const p = { mode: 'egress' as const, allow: ['*.github.com', 'pypi.org'] };
    expect(isHostAllowed('api.github.com', p)).toBe(true);
    expect(isHostAllowed('pypi.org', p)).toBe(true);
    expect(isHostAllowed('evil.com', p)).toBe(false);
  });

  it('mode full allows the internet', () => {
    expect(isHostAllowed('api.github.com', { mode: 'full' })).toBe(true);
  });

  it('mode full still refuses the metadata service and the LAN', () => {
    // The drift this consolidation existed to end.
    expect(isHostAllowed('169.254.169.254', { mode: 'full' })).toBe(false);
    expect(isHostAllowed('127.0.0.1', { mode: 'full' })).toBe(false);
    expect(isHostAllowed('192.168.1.1', { mode: 'full' })).toBe(false);
  });

  it('lets an operator opt in to an internal host deliberately', () => {
    expect(isHostAllowed('127.0.0.1', { mode: 'egress', allow: ['127.0.0.1'] })).toBe(true);
    expect(isHostAllowed('169.254.169.254', { mode: 'full', allow: ['169.254.169.254'] })).toBe(true);
  });

  it('deny beats allow', () => {
    expect(isHostAllowed('x.github.com', { mode: 'egress', allow: ['*.github.com'], deny: ['x.github.com'] })).toBe(
      false,
    );
  });

  it('an absent policy allows the internet but not the LAN', () => {
    expect(isHostAllowed('example.com', undefined)).toBe(true);
    expect(isHostAllowed('169.254.169.254', undefined)).toBe(false);
  });
});

describe('networkEnforcement', () => {
  it('has nothing to say when there is no policy, or the provider enforces it', () => {
    expect(networkEnforcement('local', undefined)).toBeUndefined();
    expect(networkEnforcement('docker', { mode: 'none' })).toBeUndefined();
    expect(networkEnforcement('podman', { mode: 'none' })).toBeUndefined();
    expect(networkEnforcement('local', { mode: 'full' })).toBeUndefined();
  });

  it('says "none" holds only for Husk\'s tools and the browser where the kernel does not stop processes', () => {
    for (const provider of ['local', 'ssh', 'fly']) {
      expect(networkEnforcement(provider, { mode: 'none' })).toMatch(new RegExp(`not enforced on ${provider}.*a process in the computer can still reach the network`));
    }
  });

  it('says no provider firewalls egress or a deny list for processes', () => {
    for (const provider of ['docker', 'podman', 'local', 'ssh', 'fly']) {
      expect(networkEnforcement(provider, { mode: 'egress', allow: ['pypi.org'] })).toMatch(/no provider firewalls it yet/);
      expect(networkEnforcement(provider, { mode: 'full', deny: ['example.com'] })).toMatch(/deny list/);
    }
  });
});

describe('urlHost', () => {
  it('extracts the hostname', () => {
    expect(urlHost('https://api.example.com/x?y=1')).toBe('api.example.com');
  });
  it('returns null rather than throwing', () => {
    expect(urlHost('not a url')).toBeNull();
  });
});

describe('assertUrlAllowed', () => {
  const open = { mode: 'full' as const };

  it('returns the parsed URL so a caller cannot check one string and fetch another', () => {
    const u = assertUrlAllowed('https://example.com/a', open);
    expect(u.hostname).toBe('example.com');
    expect(u.pathname).toBe('/a');
  });

  it('refuses a non-http scheme', () => {
    // file:// would read the host filesystem through what looks like a fetch.
    expect(() => assertUrlAllowed('file:///etc/passwd', open)).toThrowError(/scheme/);
    expect(() => assertUrlAllowed('gopher://example.com', open)).toThrowError(/scheme/);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertUrlAllowed('example.com', open)).toThrowError(/not a valid URL/);
  });

  it('refuses a blocked host and explains which knob to turn', () => {
    try {
      assertUrlAllowed('http://169.254.169.254/latest/meta-data/', open);
      throw new Error('should have refused');
    } catch (e) {
      const err = e as { code: string; hint?: string; details?: Record<string, unknown> };
      expect(err.code).toBe('E_EXEC_DENIED');
      expect(err.hint).toMatch(/network\.allow/);
      expect(err.details?.internal).toBe(true);
    }
  });

  it('gives a different hint for an ordinary host outside the allow-list', () => {
    try {
      assertUrlAllowed('https://evil.com', { mode: 'egress', allow: ['example.com'] });
      throw new Error('should have refused');
    } catch (e) {
      const err = e as { hint?: string; details?: Record<string, unknown> };
      expect(err.details?.internal).toBe(false);
      expect(err.hint).toMatch(/mode: full|network\.allow/);
    }
  });
});

describe('loopback is provider-dependent', () => {
  const full = { mode: 'full' as const };

  it('refuses loopback when the computer shares the host network', () => {
    // `local` and `ssh`: 127.0.0.1 is somebody else's machine.
    expect(isHostAllowed('127.0.0.1', full, { loopbackIsOwn: false })).toBe(false);
    expect(isHostAllowed('localhost', full, {})).toBe(false);
  });

  it('permits loopback when the computer owns its own namespace', () => {
    // docker/podman/fly: this is how "start a dev server and look at it" works.
    expect(isHostAllowed('127.0.0.1', full, { loopbackIsOwn: true })).toBe(true);
    expect(isHostAllowed('localhost', full, { loopbackIsOwn: true })).toBe(true);
    expect(isHostAllowed('[::1]', full, { loopbackIsOwn: true })).toBe(true);
  });

  it('still refuses the metadata endpoint on an isolated provider', () => {
    // Owning your loopback says nothing about link-local. Fly runs on a cloud.
    expect(isHostAllowed('169.254.169.254', full, { loopbackIsOwn: true })).toBe(false);
  });

  it('still refuses RFC1918 on an isolated provider', () => {
    expect(isHostAllowed('10.0.0.5', full, { loopbackIsOwn: true })).toBe(false);
    expect(isHostAllowed('192.168.1.1', full, { loopbackIsOwn: true })).toBe(false);
  });

  it('honours an explicit allow even on a shared-network provider', () => {
    expect(isHostAllowed('127.0.0.1', { mode: 'egress', allow: ['127.0.0.1'] }, {})).toBe(true);
  });

  it('still applies the mode after the loopback carve-out', () => {
    // Owning loopback is permission to be considered, not a bypass.
    expect(isHostAllowed('127.0.0.1', { mode: 'none' }, { loopbackIsOwn: true })).toBe(false);
    expect(isHostAllowed('127.0.0.1', { mode: 'egress' }, { loopbackIsOwn: true })).toBe(false);
  });

  it('separates loopback from the other private ranges', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('169.254.169.254')).toBe(false);
  });

  it('explains which of the two refusals happened', () => {
    try {
      assertUrlAllowed('http://127.0.0.1:8111/', full, { loopbackIsOwn: false });
      throw new Error('should have refused');
    } catch (e) {
      const err = e as { hint?: string; details?: Record<string, unknown> };
      expect(err.hint).toMatch(/loopback is the host machine/);
      expect(err.details?.loopback).toBe(true);
    }
  });
});

describe('IPv6 at the internal-address floor', () => {
  it('refuses the metadata endpoint however IPv6 spells it', () => {
    for (const h of ['[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[64:ff9b::a9fe:a9fe]']) {
      expect(isHostAllowed(h, { mode: 'full' }, { loopbackIsOwn: true }), h).toBe(false);
    }
  });

  it('treats IPv4 loopback inside IPv6, and the unspecified address, as loopback', () => {
    for (const h of ['[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '[::]', '[::1]']) {
      expect(isLoopbackHost(h), h).toBe(true);
      expect(isHostAllowed(h, undefined), h).toBe(false);
      expect(isHostAllowed(h, undefined, { loopbackIsOwn: true }), h).toBe(true);
    }
  });

  it('refuses private, unique-local and link-local ranges, and lets public IPv6 through', () => {
    for (const h of ['[::ffff:10.0.0.1]', '[fd12:3456::1]', '[fe80::1]', '[febf::1]']) expect(isInternalHost(h), h).toBe(true);
    expect(isHostAllowed('[2606:4700::1111]', { mode: 'full' })).toBe(true);
    expect(isInternalHost('[2606:4700::1111]')).toBe(false);
  });
});
