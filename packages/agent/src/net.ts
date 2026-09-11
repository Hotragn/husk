import { HuskError } from '@husk/core';
import type { NetworkPolicy } from '@husk/core';

/**
 * Host matching for the husk's NetworkPolicy.
 *
 * This duplicates `@husk/runtime`'s policy helpers on purpose: the dependency
 * direction is core <- runtime <- agent, and agent may only import core. The
 * rules are small enough to restate exactly, and both copies are tested, so a
 * host refused in one place is refused in the other.
 */

/** Match a hostname against one pattern. Supports a single leading `*.` wildcard. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase().replace(/\.$/, '');
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

export function isHostAllowed(host: string, policy: NetworkPolicy | undefined): boolean {
  if (!policy) return true;
  if (policy.deny?.some((p) => hostMatches(host, p))) return false;
  switch (policy.mode) {
    case 'none':
      return false;
    case 'full':
      return true;
    case 'egress':
      // An egress policy with no allow-list allows nothing. Reading the empty
      // list as "everything" is the interpretation that leaks data.
      return (policy.allow ?? []).some((p) => hostMatches(host, p));
    default:
      return false;
  }
}

export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Loopback, link-local, and RFC1918 space.
 *
 * `mode: 'full'` means "reach the public internet", not "reach the cloud metadata
 * endpoint and the database on the host bridge". Those are only reachable when the
 * operator names them in `allow`.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) {
    return true;
  }
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }
  const m = IPV4.exec(h);
  if (!m) return false;
  const parts = m.slice(1, 5).map((p) => Number(p));
  const [a, b] = parts as [number, number, number, number];
  if (parts.some((n) => n > 255)) return false;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Parse and authorise a URL, or throw something the model can act on. */
export function assertUrlAllowed(url: string, policy: NetworkPolicy | undefined): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HuskError('E_TOOL_ERROR', `not a valid URL: ${url}`, {
      hint: 'pass an absolute URL including the scheme, e.g. https://example.com',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HuskError('E_EXEC_DENIED', `refused ${parsed.protocol} URL`, {
      hint: 'only http and https are fetchable from a husk',
    });
  }

  const host = parsed.hostname;
  const explicitlyAllowed = (policy?.allow ?? []).some((p) => hostMatches(host, p));

  if (!isHostAllowed(host, policy)) {
    throw new HuskError('E_EXEC_DENIED', `network policy refuses ${host}`, {
      hint:
        policy?.mode === 'none'
          ? 'this husk has no network access; set computer.network.mode to egress or full in husk.yaml'
          : `add "${host}" to computer.network.allow in husk.yaml`,
      details: { host, mode: policy?.mode ?? 'full' },
    });
  }

  if (isPrivateHost(host) && !explicitlyAllowed) {
    throw new HuskError('E_EXEC_DENIED', `refused private address ${host}`, {
      hint: `loopback, link-local and RFC1918 hosts must be named in computer.network.allow`,
      details: { host },
    });
  }

  return parsed;
}
