import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, posix, resolve, sep } from 'node:path';
import { HuskError, completeCharEnd } from '@husk-ai/core';
import { DEFAULT_DENY, type CommandRule } from './deny.js';

/**
 * The guardrails.
 *
 * These functions are the only thing standing between an agent and the user's
 * actual machine on the `local` provider. They are pure so they can be tested
 * exhaustively, and they are shared with the OCI providers so a command that is
 * refused in one place is refused everywhere.
 */

// ---------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------

/** The virtual filesystem a husk presents, regardless of what is underneath. */
export const GUEST_ROOT = '/work';
export const GUEST_TMP = '/tmp';

/**
 * Normalise a path as the *guest* sees it. Relative paths resolve against /work.
 * Always returns a POSIX absolute path with no `.`, `..`, or duplicate separators.
 */
export function normaliseGuestPath(input: string, cwd: string = GUEST_ROOT): string {
  const raw = input.replace(/\\/g, '/').trim();
  const abs = raw.startsWith('/') ? raw : posix.join(cwd, raw);
  return posix.normalize(abs).replace(/\/+$/, '') || '/';
}

export interface JailMap {
  /** Host directory backing GUEST_ROOT. */
  root: string;
  /** Host directory backing GUEST_TMP. */
  tmp: string;
}

/**
 * Translate a guest path to a host path, refusing anything that escapes the jail.
 *
 * This is a *lexical* check. It is correct for `..` traversal and for absolute
 * paths pointing anywhere else on the machine, but it cannot see a symlink that
 * was created inside the workspace and points out of it -- use {@link assertInJail}
 * for the resolved check before an operation that follows links.
 */
export function toHostPath(guestPath: string, map: JailMap, cwd: string = GUEST_ROOT): string {
  const g = normaliseGuestPath(guestPath, cwd);

  for (const [prefix, hostBase] of [
    [GUEST_ROOT, map.root],
    [GUEST_TMP, map.tmp],
  ] as const) {
    if (g === prefix || g.startsWith(prefix + '/')) {
      const rel = g.slice(prefix.length).replace(/^\//, '');
      const host = rel ? resolve(hostBase, ...rel.split('/')) : resolve(hostBase);
      // resolve() collapses `..`, so a lexical containment test is sound here.
      if (host !== resolve(hostBase) && !host.startsWith(resolve(hostBase) + sep)) {
        throw new HuskError('E_FS_DENIED', `path escapes the workspace: ${guestPath}`, {
          hint: `paths must stay inside ${GUEST_ROOT} or ${GUEST_TMP}`,
        });
      }
      return host;
    }
  }

  throw new HuskError('E_FS_DENIED', `path is outside the machine's writable area: ${g}`, {
    hint: `this computer exposes ${GUEST_ROOT} and ${GUEST_TMP}; use a path under one of them`,
    details: { path: g },
  });
}

/** Map a host path back to what the guest should see. Best effort; used for listings. */
export function toGuestPath(hostPath: string, map: JailMap): string {
  const h = resolve(hostPath);
  for (const [prefix, hostBase] of [
    [GUEST_ROOT, map.root],
    [GUEST_TMP, map.tmp],
  ] as const) {
    const base = resolve(hostBase);
    if (h === base) return prefix;
    if (h.startsWith(base + sep)) {
      return posix.join(prefix, h.slice(base.length + 1).split(sep).join('/'));
    }
  }
  return h.split(sep).join('/');
}

/**
 * Resolve symlinks and confirm the real target is still inside the jail.
 *
 * Checks the nearest existing ancestor rather than the leaf, so it works for a
 * path that is about to be created.
 */
export async function assertInJail(hostPath: string, map: JailMap): Promise<void> {
  const roots: string[] = [];
  let rootMissing = true;
  for (const r of [map.root, map.tmp]) {
    try {
      roots.push(await realpath(r));
      rootMissing = false;
    } catch {
      roots.push(resolve(r));
    }
  }

  // The workspace itself is gone -- destroyed by `husk rm`, by the reaper, or by
  // a second process sharing this computer. Without this check the walk below
  // climbs past the deleted directory to a surviving ancestor, decides the path
  // escaped, and blames a symlink that never existed. That message sent a real
  // tester hunting for a link for twenty minutes.
  if (rootMissing) {
    throw new HuskError('E_COMPUTER_NOT_FOUND', 'this computer’s workspace no longer exists', {
      hint: 'it was destroyed while in use -- `husk ps` to see what is left, `husk up` for a fresh one',
      details: { workspace: resolve(map.root) },
    });
  }

  let probe = resolve(hostPath);
  let real: string | undefined;
  for (let i = 0; i < 64; i++) {
    try {
      real = await realpath(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (!real) return;

  const ok = roots.some((r) => real === r || real!.startsWith(r + sep));
  if (!ok) {
    throw new HuskError('E_FS_DENIED', 'path resolves outside the workspace through a symlink', {
      hint: 'husk refuses to follow links that leave the machine',
      details: { resolved: real },
    });
  }
}

// ---------------------------------------------------------------------------
// Environment scrubbing
// ---------------------------------------------------------------------------

const SECRET_ENV_PATTERNS = [
  /API_KEY$/i,
  /_TOKEN$/i,
  /^TOKEN$/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /_KEY$/i,
  /CREDENTIALS/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_APPLICATION/i,
  /^GH_/i,
  /^GITHUB_TOKEN/i,
  /^NPM_TOKEN/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /SESSION/i,
  /COOKIE/i,
];

/** Variables a shell genuinely needs to behave like a shell. */
const ENV_ALLOW = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'PWD',
  'SYSTEMROOT',
  'COMSPEC',
  'WINDIR',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);

export interface ScrubResult {
  env: Record<string, string>;
  /** Names that were withheld, so the caller can say so out loud. */
  removed: string[];
}

/**
 * Build the environment a command runs with.
 *
 * The allow-list is the real boundary: anything not on it is dropped, whether or
 * not it looks like a credential. The pattern list only exists to *classify*
 * what was dropped, so `husk` can tell the user it withheld their API key
 * rather than silently shipping a smaller environment.
 */
export function scrubEnv(hostEnv: NodeJS.ProcessEnv, explicit: Record<string, string> = {}): ScrubResult {
  const env: Record<string, string> = {};
  const removed: string[] = [];

  for (const [k, v] of Object.entries(hostEnv)) {
    if (v === undefined) continue;
    if (ENV_ALLOW.has(k.toUpperCase())) {
      env[k] = v;
      continue;
    }
    // A smaller environment is a smaller blast radius, and agents rarely miss it.
    removed.push(k);
  }

  // Explicit spec values always win -- the user asked for them.
  for (const [k, v] of Object.entries(explicit)) env[k] = v;

  env.HUSK = '1';
  return { env, removed };
}

/** Whether a withheld variable looked like a credential. Used for reporting only. */
export function looksSecret(name: string): boolean {
  return SECRET_ENV_PATTERNS.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// Command policy
// ---------------------------------------------------------------------------

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  rule?: string;
}

/**
 * Decide whether a command may run.
 *
 * `allow` wins over `deny`: an explicit allow-list entry is the user telling us
 * they know better about their own machine, and they do.
 */
export function evaluateCommand(
  cmd: string | string[],
  opts: { deny?: string[]; allow?: string[]; extraRules?: CommandRule[] } = {},
): PolicyDecision {
  const text = Array.isArray(cmd) ? cmd.join(' ') : cmd;

  for (const a of opts.allow ?? []) {
    try {
      if (new RegExp(a).test(text)) return { allowed: true };
    } catch {
      if (text.includes(a)) return { allowed: true };
    }
  }

  for (const d of opts.deny ?? []) {
    try {
      if (new RegExp(d).test(text)) {
        return { allowed: false, reason: 'matched a deny rule from this husk', rule: d };
      }
    } catch {
      if (text.includes(d)) return { allowed: false, reason: 'matched a deny rule from this husk', rule: d };
    }
  }

  for (const rule of [...DEFAULT_DENY, ...(opts.extraRules ?? [])]) {
    if (rule.pattern.test(text)) {
      return { allowed: false, reason: rule.reason, rule: String(rule.pattern) };
    }
  }

  return { allowed: true };
}

/** Throwing wrapper, for call sites that have nothing useful to do with a `false`. */
export function assertCommandAllowed(
  cmd: string | string[],
  opts: Parameters<typeof evaluateCommand>[1] = {},
): void {
  const d = evaluateCommand(cmd, opts);
  if (!d.allowed) {
    throw new HuskError('E_EXEC_DENIED', `refused: ${d.reason}`, {
      hint: 'add a matching pattern to guardrails.allowCommands in husk.yaml if this is intentional',
      details: { rule: d.rule },
    });
  }
}

// ---------------------------------------------------------------------------
// Output clamping for streaming execs
// ---------------------------------------------------------------------------

/**
 * Accumulates process output under a byte budget, keeping the head and the tail.
 *
 * The middle of a runaway build log is never the interesting part; the command
 * that started it and the error that ended it are.
 */
/**
 * Skip orphaned continuation bytes at the front of a buffer.
 *
 * A truncated stream's tail starts wherever the byte budget put it, which may
 * be inside a character whose lead byte was dropped.
 */
function firstCharBoundary(buf: Buffer): number {
  let i = 0;
  while (i < buf.byteLength && (buf[i]! & 0xc0) === 0x80) i++;
  return i;
}

export class OutputBuffer {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;
  private readonly headMax: number;
  private readonly tailMax: number;

  constructor(private readonly maxBytes: number) {
    this.headMax = Math.floor(maxBytes * 0.6);
    this.tailMax = maxBytes - this.headMax;
  }

  push(chunk: Buffer): void {
    this.total += chunk.byteLength;
    if (this.headBytes < this.headMax) {
      const take = Math.min(chunk.byteLength, this.headMax - this.headBytes);
      this.head.push(chunk.subarray(0, take));
      this.headBytes += take;
      if (take === chunk.byteLength) return;
      chunk = chunk.subarray(take);
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.byteLength;
    // Drop whole chunks first, then slice into the oldest survivor -- a single
    // multi-megabyte write must be trimmed too, not just a long series of writes.
    while (this.tailBytes > this.tailMax && this.tail.length > 1) {
      const dropped = this.tail.shift()!;
      this.tailBytes -= dropped.byteLength;
    }
    if (this.tailBytes > this.tailMax && this.tail.length === 1) {
      const only = this.tail[0]!;
      const keep = only.subarray(only.byteLength - this.tailMax);
      this.tail[0] = keep;
      this.tailBytes = keep.byteLength;
    }
  }

  get truncated(): boolean {
    return this.total > this.headBytes + this.tailBytes;
  }

  toString(): string {
    const headBuf = Buffer.concat(this.head);
    const tailBuf = Buffer.concat(this.tail);
    if (!this.truncated) return Buffer.concat([headBuf, tailBuf]).toString('utf8');

    // The cut between head and tail sits at a byte offset chosen by a size
    // limit, not by the text, so it lands inside a multi-byte character often
    // enough to matter. Decode each side across whole characters only; the
    // stray bytes join the elided count, where they are at least accounted
    // for, instead of becoming U+FFFD that reads as if the command itself had
    // emitted garbage.
    const headEnd = completeCharEnd(headBuf);
    const tailStart = firstCharBoundary(tailBuf);
    const head = headBuf.subarray(0, headEnd).toString('utf8');
    const tail = tailBuf.subarray(tailStart).toString('utf8');

    const omitted = this.total - headEnd - (tailBuf.byteLength - tailStart);
    return `${head}\n... [${omitted} bytes elided by husk] ...\n${tail}`;
  }
}

/** Join an argv array into something safe to hand a POSIX shell. */
export function shellQuote(args: string[]): string {
  return args
    .map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

export { normalize, isAbsolute, join };

// Network policy has exactly one implementation, in @husk-ai/core. It is
// re-exported here so runtime callers and the existing tests are unaffected --
// three copies had already drifted on whether `mode: 'full'` reaches the cloud
// metadata endpoint, and a security check with two answers is not a check.
export { hostMatches, isInternalHost, isHostAllowed, urlHost, assertUrlAllowed } from '@husk-ai/core';
export { DEFAULT_DENY, type CommandRule } from './deny.js';
