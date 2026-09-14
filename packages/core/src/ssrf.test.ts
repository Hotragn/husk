/**
 * The spellings of an address that a four-octet regex does not recognise.
 *
 * `isInternalHost` matched `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`, which is
 * how everyone writes an IPv4 address and not how everyone *can* write one.
 * `127.1`, `2130706433` and `0x7f000001` are the same host to curl, to a
 * browser and to Python's urllib -- so the floor that refuses loopback and the
 * cloud metadata endpoint had a documented, one-line way around it.
 *
 * Found by probing the rule rather than reading it: `isInternalHost('127.1')`
 * returned false while `isInternalHost('127.0.0.1')` returned true.
 */

import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, isInternalHost, isLoopbackHost } from './net.js';

describe('IPv4 spellings of loopback', () => {
  // Every one of these is 127.0.0.1 to inet_aton, which is what the OS and
  // every HTTP client ultimately use to resolve it.
  const loopback = ['127.0.0.1', '127.1', '127.0.1', '2130706433', '0x7f000001', '017700000001'];

  it.each(loopback)('treats %s as internal', (host) => {
    expect(isInternalHost(host)).toBe(true);
  });

  it.each(loopback)('treats %s as loopback specifically', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it('treats a bare 0 as loopback, because it routes there', () => {
    expect(isLoopbackHost('0')).toBe(true);
  });
});

describe('IPv4 spellings of the ranges that matter', () => {
  it.each([
    ['169.254.169.254', 'cloud metadata, dotted'],
    ['2852039166', 'cloud metadata, decimal'],
    ['10.0.0.1', 'RFC1918, dotted'],
    ['0xa000001', 'RFC1918, hex'],
    ['192.168.1.1', 'home router'],
    ['3232235777', 'home router, decimal'],
    ['172.16.0.1', 'RFC1918 middle block'],
    ['100.64.0.1', 'carrier-grade NAT'],
  ])('%s is internal (%s)', (host) => {
    expect(isInternalHost(host)).toBe(true);
  });
});

describe('public addresses stay public', () => {
  // A floor that catches everything is not a floor, it is an outage. These are
  // the neighbours of the private ranges, where an off-by-one would show up.
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '126.255.255.255', '128.0.0.1', '9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.1', '192.167.255.255', '192.169.0.0'])(
    '%s is not internal',
    (host) => {
      expect(isInternalHost(host)).toBe(false);
    },
  );

  it('does not mistake a hostname for an address', () => {
    expect(isInternalHost('example.com')).toBe(false);
    expect(isInternalHost('8.8.8.8.example.com')).toBe(false);
  });

  it('rejects malformed octets rather than guessing', () => {
    // `256.1.1.1` is not an address; treating it as one either way would be a
    // decision made by accident.
    expect(isInternalHost('256.1.1.1')).toBe(false);
    expect(isInternalHost('127.0.0.1.1')).toBe(false);
    expect(isInternalHost('1..2.3')).toBe(false);
    expect(isInternalHost('127.0.0.x')).toBe(false);
  });
});

describe('the floor holds through assertUrlAllowed', () => {
  const permissive = { mode: 'full' as const };

  it.each([
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://2852039166/latest/meta-data/iam/security-credentials/',
  ])('refuses %s even in mode: full', (url) => {
    expect(() => assertUrlAllowed(url, permissive, {})).toThrow(/network policy refuses/);
  });

  it('still allows the actual internet', () => {
    expect(() => assertUrlAllowed('https://example.com/', permissive, {})).not.toThrow();
  });

  it('lets a container reach its own loopback, in every spelling', () => {
    // The carve-out exists so an agent can look at a server it just started.
    // It has to apply to the short forms too, or the exception is arbitrary.
    for (const url of ['http://127.0.0.1:3000/', 'http://127.1:3000/']) {
      expect(() => assertUrlAllowed(url, permissive, { loopbackIsOwn: true })).not.toThrow();
    }
  });
});
