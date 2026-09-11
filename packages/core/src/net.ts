import { HuskError } from './errors.js';
import type { NetworkPolicy } from './types/computer.js';

/**
 * Network policy, in one place.
 *
 * This lived in three copies -- `@husk/runtime`, `@husk/agent`, and by
 * implication the docs -- and they drifted: one blocked the cloud metadata
 * endpoint in `mode: 'full'` and one did not. A security check with two answers
 * is not a security check, so it lives here and everything re-exports it.
 */

/** Match a hostname against one pattern. Supports a single leading `*.` wildcard. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase().replace(/\.$/, '');
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

/**
 * Hosts that are never reachable by default, whatever the mode says.
 *
 * `mode: 'full'` means "the internet", not "and also the cloud metadata
 * service". 169.254.169.254 hands out IAM credentials to anything that asks,
 * and a prompt-injected agent will ask. Loopback and the RFC1918 ranges are the
 * same problem one hop out: the host's own admin panels, and the LAN.
 *
 * An operator who genuinely wants one of these names it in `allow`, where a
 * reviewer reading the husk.yaml can see the decision.
 */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. the metadata endpoint
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  }
  return false;
}

/** Loopback specifically, as distinct from the rest of the private ranges. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const v4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(h);
  return v4 !== null && (Number(v4[1]) === 127 || Number(v4[1]) === 0);
}

export interface HostPolicyContext {
  /**
   * True when this computer's loopback is its own, not the host's.
   *
   * The whole point of the loopback rule is to stop an agent reaching the
   * *host's* services. On docker, podman and fly, `127.0.0.1` inside the
   * computer is a separate network namespace, so "start a dev server and look
   * at it" -- the single most common thing an agent does -- is both safe and
   * necessary. On the `local` provider loopback is literally the host's, and on
   * `ssh` it is a box the user may well be running things on, so both stay shut
   * unless the operator names the host in `allow`.
   */
  loopbackIsOwn?: boolean;
}

export function isHostAllowed(
  host: string,
  policy: NetworkPolicy | undefined,
  ctx: HostPolicyContext = {},
): boolean {
  const explicitlyAllowed = (policy?.allow ?? []).some((p) => hostMatches(host, p));

  // The floor is checked before the mode, so `full` cannot reach the metadata
  // service. Loopback is carved out of it when the computer owns its own.
  if (!explicitlyAllowed) {
    if (isLoopbackHost(host)) {
      if (!ctx.loopbackIsOwn) return false;
    } else if (isInternalHost(host)) {
      return false;
    }
  }

  if (!policy) return true;
  if (policy.deny?.some((p) => hostMatches(host, p))) return false;

  switch (policy.mode) {
    case 'none':
      return false;
    case 'full':
      return true;
    case 'egress':
      // An egress policy with no allow-list allows nothing. Reading it as
      // "unrestricted" would be the dangerous interpretation.
      return explicitlyAllowed;
  }
}

/** The hostname of a URL, or null when it does not parse. */
export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Parse and authorise a URL in one step.
 *
 * Returns the parsed URL so a caller cannot accidentally check one string and
 * then fetch a different one.
 */
export function assertUrlAllowed(
  url: string,
  policy: NetworkPolicy | undefined,
  ctx: HostPolicyContext = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HuskError('E_EXEC_DENIED', `not a valid URL: ${url}`, {
      hint: 'include the scheme, e.g. https://example.com',
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HuskError('E_EXEC_DENIED', `refusing the ${parsed.protocol} scheme`, {
      hint: 'only http and https are fetched; file:// would read the host filesystem',
    });
  }

  if (!isHostAllowed(parsed.hostname, policy, ctx)) {
    const loopback = isLoopbackHost(parsed.hostname);
    const internal = isInternalHost(parsed.hostname);
    throw new HuskError('E_EXEC_DENIED', `network policy refuses ${parsed.hostname}`, {
      hint:
        loopback && !ctx.loopbackIsOwn
          ? 'on this provider loopback is the host machine, not the computer -- use an isolated ' +
            'provider (docker, podman, fly) to reach a server the agent started, or name the ' +
            'host in computer.network.allow'
          : internal
            ? 'link-local and RFC1918 hosts must be named in computer.network.allow'
            : `add it to computer.network.allow, or set computer.network.mode: full`,
      details: { host: parsed.hostname, mode: policy?.mode ?? 'unset', internal, loopback },
    });
  }

  return parsed;
}
