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
/**
 * Normalise the many spellings of one IPv4 address.
 *
 * `127.1`, `2130706433` and `0x7f000001` are all `127.0.0.1` to every resolver
 * that matters -- curl, the browser, and Python's urllib all accept them --
 * and a rule that only understands four dotted octets waves each of them
 * through. Measured: `isInternalHost('127.1')` returned false while
 * `isInternalHost('127.0.0.1')` returned true.
 *
 * Returns the four octets, or null when this is not an IPv4 literal at all.
 */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((p) => p === '')) return null;

  // Each part may be decimal, octal (leading zero) or hex (0x). inet_aton
  // accepts all three, so refusing to understand them is not a defence.
  const nums: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8);
    else if (/^[0-9]+$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    nums.push(value);
  }

  // The last part absorbs the remaining octets: `127.1` is 127.0.0.1 and
  // `2130706433` is the whole address in one number.
  const last = nums.pop();
  if (last === undefined) return null;
  const width = 4 - nums.length;
  if (last >= 256 ** width) return null;
  if (nums.some((n) => n > 255)) return null;

  const tail: number[] = [];
  for (let i = width - 1; i >= 0; i--) tail.push((last >>> (8 * i)) & 0xff);
  const all = [...nums, ...tail];
  return all.length === 4 ? (all as [number, number, number, number]) : null;
}

export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;

  const v4 = ipv4Octets(h);
  if (v4) {
    const a = v4[0];
    const b = v4[1];
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
  const v4 = ipv4Octets(h);
  return v4 !== null && (v4[0] === 127 || v4[0] === 0);
}

/**
 * Providers where the computer has its own network namespace.
 *
 * On these, `127.0.0.1` inside the computer is the computer, so an agent can
 * start a server and look at it -- the most common thing it will ever want to
 * do. On `local` that address is the host's own loopback, and on `ssh` it
 * belongs to a box the user may be running things on, so neither qualifies.
 *
 * This lives here, beside `isHostAllowed`, because it is the same policy
 * question and it had already been copied into three files. `net.ts` exists to
 * be the one answer: the last time this rule had two copies, they disagreed
 * about whether `mode: 'full'` could reach the cloud metadata endpoint.
 */
const OWNS_LOOPBACK: ReadonlySet<string> = new Set(['docker', 'podman', 'fly']);

/** Whether this provider's loopback belongs to the computer rather than the host. */
export function ownsLoopback(provider: string): boolean {
  return OWNS_LOOPBACK.has(provider);
}

/**
 * Whether the computer shares a network stack with whoever is running husk.
 *
 * The inverse of {@link ownsLoopback}, named for the thing a caller usually
 * wants to warn about.
 */
export function sharesHostNetwork(provider: string): boolean {
  return !OWNS_LOOPBACK.has(provider);
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
