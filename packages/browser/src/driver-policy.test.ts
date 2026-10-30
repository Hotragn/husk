import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, isHostAllowed } from '@husk-ai/core';
import type { NetworkPolicy } from '@husk-ai/core';

/**
 * The driver's copy of the network policy, held to net.ts's answers.
 *
 * The host checks the URLs it sends the browser to; the driver checks the
 * documents a page loads by itself, with net.ts ported to Python. A security
 * check with two answers is not a security check, so every host spelling and
 * policy below goes through both, and they must agree on every one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['-c', 'pass']).status === 0);

function driverSays(fn: 'host_allowed' | 'policy_refuses', cases: unknown[]): unknown[] {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(here)})`,
    'import driver',
    'cases = json.load(sys.stdin)',
    fn === 'host_allowed'
      ? "print(json.dumps([driver.host_allowed(c['host'], c['policy'], c['own']) for c in cases]))"
      : "print(json.dumps([driver.policy_refuses(c['url'], {'network': c['policy'], 'loopbackIsOwn': c['own']}) for c in cases]))",
  ].join('\n');
  const run = spawnSync(python!, ['-c', script], { input: JSON.stringify(cases), encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as unknown[];
}

const HOSTS = [
  'example.com', 'EXAMPLE.COM.', 'www.github.com', 'github.com', 'evil.github.com.attacker.net', 'pypi.org',
  'localhost', 'foo.localhost', 'printer.local', 'db.internal', 'metadata.google.internal',
  '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0x7f.1', '017700000001', '0.0.0.0',
  '10.0.0.1', '172.16.0.1', '172.31.255.255', '172.32.0.1', '192.168.1.1', '100.64.0.1', '100.128.0.1',
  '169.254.169.254', '8.8.8.8', '256.1.1.1', '1.2.3.4.5',
  '[::1]', '::1', '[::]', '[fe80::1]', '[fc00::1]', '[fd12:3456::1]', '[fec0::1]', '[2001:db8::1]',
  '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[::ffff:7f00:1]', '[::127.0.0.1]', '[64:ff9b::a9fe:a9fe]',
  '[64:ff9b::808:808]', '[::ffff:8.8.8.8]', '[1:2:3:4:5:6:7:8:9]', '[::1::2]',
];

const POLICIES: Array<NetworkPolicy | undefined> = [
  undefined,
  { mode: 'full' },
  { mode: 'none' },
  { mode: 'egress' },
  { mode: 'egress', allow: ['*.github.com', 'pypi.org'] },
  { mode: 'full', deny: ['example.com', '*.github.com'] },
  { mode: 'full', allow: ['10.0.0.1', 'localhost'] },
  { mode: 'egress', allow: ['*'] },
];

describe.skipIf(!python)("the driver's network policy", { timeout: 60_000 }, () => {
  it('answers every host as net.ts does, under every policy, loopback owned or not', () => {
    const cases = HOSTS.flatMap((host) => POLICIES.flatMap((policy) => [true, false].map((own) => ({ host, policy: policy ?? null, own }))));
    const got = driverSays('host_allowed', cases);
    const wrong = cases.filter((c, i) => got[i] !== isHostAllowed(c.host, c.policy ?? undefined, { loopbackIsOwn: c.own }));
    expect(wrong).toEqual([]);
    // And the table is not trivially all one answer.
    expect(new Set(got).size).toBe(2);
  });

  it('refuses a whole URL exactly when assertUrlAllowed does, however its host is spelled', () => {
    const urls = HOSTS.filter((h) => !h.endsWith('.') && !h.includes('::1::') && h !== '1.2.3.4.5' && h !== '256.1.1.1' && !h.startsWith('[1:2:3'))
      .map((h) => `http://${h.startsWith('[') || !h.includes(':') ? h : `[${h}]`}/path?q=1`)
      .concat(['https://user:pw@[::ffff:169.254.169.254]:8443/x', 'http://169.254.169.254.nip.io/', 'HTTP://LOCALHOST:3000/']);
    const cases = urls.flatMap((url) => POLICIES.flatMap((policy) => [true, false].map((own) => ({ url, policy: policy ?? null, own }))));
    const got = driverSays('policy_refuses', cases);
    const allowed = (c: (typeof cases)[number]) => {
      try {
        assertUrlAllowed(c.url, c.policy ?? undefined, { loopbackIsOwn: c.own });
        return true;
      } catch {
        return false;
      }
    };
    const wrong = cases.filter((c, i) => (got[i] === null) !== allowed(c));
    expect(wrong).toEqual([]);
  });

  it("leaves a page's own documents alone: about:, data: and blob: never leave the browser", () => {
    const own = ['about:blank', 'data:text/html,hi', 'blob:http://example.com/uuid'].map((url) => ({ url, policy: { mode: 'none' }, own: false }));
    expect(driverSays('policy_refuses', own)).toEqual([null, null, null]);
  });
});
