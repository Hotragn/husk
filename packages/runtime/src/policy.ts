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
// Guest-path rewriting for shells without a real /work
// ---------------------------------------------------------------------------

type QuoteState = 'normal' | 'single' | 'double';

/** Characters treated as part of one unquoted path token. `$`, `~`, quotes and
 * shell metacharacters all terminate the token: expansions must stay outside the
 * replacement so they still expand. */
const PATH_TOKEN_CHAR = /^[A-Za-z0-9_@%+=.,/-]$/;

/** A guest path is only recognised at the start of a shell word. */
function isWordBoundary(ch: string | undefined): boolean {
  return ch === undefined || /[\s()|;&<>=:,`'"{ }]/.test(ch);
}

function escapeHostPath(host: string, state: QuoteState): string {
  if (state === 'single') return host.replace(/'/g, `'\\''`);
  if (state === 'double') return host.replace(/([\\"$`])/g, '\\$1');
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(host)) return host;
  return `'${host.replace(/'/g, `'\\''`)}'`;
}

/** A heredoc whose body has not started yet. `<<-` lets the closing word be
 * indented with tabs. */
interface PendingHeredoc {
  word: string;
  stripTabs: boolean;
}

/**
 * The delimiter word after `<<`, and where it ends.
 *
 * Quoting the word changes whether the shell expands the body; it does not
 * change where the body ends, and we never expand, so `<<EOF`, `<<'EOF'` and
 * `<<"EOF"` are all read to the same terminator.
 */
function readHeredocWord(script: string, start: number): { word: string; end: number } {
  const q = script[start];
  if (q === `'` || q === '"') {
    const close = script.indexOf(q, start + 1);
    if (close === -1) return { word: '', end: start };
    return { word: script.slice(start + 1, close), end: close + 1 };
  }
  let j = start;
  while (j < script.length && /[A-Za-z0-9_.-]/.test(script[j]!)) j++;
  return { word: script.slice(start, j), end: j };
}

/** The guest prefix at position `i`, or null when this is a lookalike such as
 * `/workshop` or `example.com/work`. */
function guestPrefixAt(script: string, i: number): string | null {
  for (const prefix of [GUEST_ROOT, GUEST_TMP]) {
    if (!script.startsWith(prefix, i)) continue;
    // A '.' may be prose punctuation (`look in /work.`); the toHostPath check on
    // the trimmed token is what keeps a real lookalike like `/work.txt` untouched.
    const next = script[i + prefix.length];
    if (next === undefined || next === '/' || next === '.' || !PATH_TOKEN_CHAR.test(next)) return prefix;
  }
  return null;
}

/**
 * Rewrite guest-absolute paths in a shell script to their host equivalents.
 *
 * The WSL exec path gives the agent a real `/work` with a per-exec bind mount.
 * The plain posix shell cannot do that portably -- unprivileged user namespaces
 * are not enabled everywhere and macOS has none -- so the script's absolute
 * guest paths are mapped before the command runs, with the working directory
 * already set to the workspace. Without this, the documented contract ("write
 * a script to /work, then run it") broke on exactly the provider everyone gets
 * by default: file tools translated `/work`, the shell did not.
 *
 * The mapping is lexical and quote-aware:
 *
 *  - A path is only recognised at a word boundary, so `https://x/work` and
 *    `/workshop` are left alone.
 *  - Inside single quotes the replacement is literal; inside double quotes the
 *    host specials are backslash-escaped; elsewhere it is shell-quoted.
 *  - Trailing slashes are preserved, so `/work/$f` still concatenates correctly.
 *  - A token that would escape the jail (`/work/../../etc/passwd`) is passed
 *    through unchanged. `/work` does not exist in this mode, so it fails
 *    harmlessly instead of being "helpfully" repointed at the host.
 */
export function rewriteGuestPaths(script: string, map: JailMap): string {
  let out = '';
  let state: QuoteState = 'normal';
  let prev: string | undefined;
  let i = 0;
  const pending: PendingHeredoc[] = [];

  while (i < script.length) {
    const c = script[i]!;

    // An escaped character is never a quote or a boundary marker.
    if (c === '\\' && state !== 'single') {
      out += c + (script[i + 1] ?? '');
      prev = script[i + 1] ?? c;
      i += 2;
      continue;
    }

    // `<<WORD` opens a heredoc. Remember the terminator and keep scanning the
    // rest of the line -- `cat <<EOF > /work/out.txt` still has a real path on
    // it. `<<<` is a here-string, whose operand is an ordinary word.
    if (
      state === 'normal' &&
      c === '<' &&
      script[i + 1] === '<' &&
      script[i + 2] !== '<' &&
      // A heredoc needs a body, so a script with no newline left cannot have
      // one. This is also what keeps `$(( a << b ))` from being misread.
      script.indexOf('\n', i) !== -1
    ) {
      let j = i + 2;
      let stripTabs = false;
      if (script[j] === '-') { stripTabs = true; j++; }
      while (script[j] === ' ' || script[j] === '\t') j++;
      const { word, end } = readHeredocWord(script, j);
      if (word) {
        pending.push({ word, stripTabs });
        out += script.slice(i, end);
        prev = script[end - 1];
        i = end;
        continue;
      }
    }

    // The body of a heredoc is data, not script. Copy it through untouched:
    // rewriting it would change the bytes the agent meant to write, and a stray
    // apostrophe in prose would otherwise flip `state` for the rest of the run.
    if (c === '\n' && pending.length > 0) {
      out += c;
      i++;
      for (const h of pending.splice(0)) {
        while (i < script.length) {
          const nl = script.indexOf('\n', i);
          const lineEnd = nl === -1 ? script.length : nl;
          const line = script.slice(i, lineEnd);
          out += script.slice(i, nl === -1 ? script.length : nl + 1);
          i = nl === -1 ? script.length : nl + 1;
          if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.word) break;
        }
      }
      // The next line starts a fresh word, and quotes never span a heredoc.
      prev = '\n';
      state = 'normal';
      continue;
    }

    if (state === 'normal' && c === "'") { state = 'single'; out += c; prev = c; i++; continue; }
    if (state === 'normal' && c === '"') { state = 'double'; out += c; prev = c; i++; continue; }
    if (state === 'single' && c === "'") { state = 'normal'; out += c; prev = c; i++; continue; }
    if (state === 'double' && c === '"') { state = 'normal'; out += c; prev = c; i++; continue; }

    if (c === '/' && isWordBoundary(prev) && guestPrefixAt(script, i) !== null) {
      let j = i;
      while (j < script.length && PATH_TOKEN_CHAR.test(script[j]!)) j++;
      // Prose punctuation is not part of the path: `look in /work.`
      let end = j;
      while (end > i && script[end - 1] === '.') end--;
      const token = script.slice(i, end);
      const trailing = script.slice(end, j);

      let host: string | null = null;
      try {
        host = toHostPath(token, map);
      } catch {
        // Escapes the jail or names neither guest root: leave it for the shell,
        // where the missing /work makes it fail on its own.
      }
      if (host !== null) {
        // toHostPath normalises trailing slashes away; the shell concatenates
        // what follows verbatim (`/work/$f`), so put them back.
        const slashes = /\/+$/.exec(token)?.[0] ?? '';
        out += escapeHostPath(host, state) + slashes;
      } else {
        out += token;
      }
      out += trailing;
      prev = script[j - 1] ?? prev;
      i = j;
      continue;
    }

    out += c;
    prev = c;
    i++;
  }

  return out;
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

/** A computer's own command rules, from its labels: the husk's allow and deny lists, NUL-separated, as every provider reads them. */
export function commandRulesOf(labels: Record<string, string> | undefined): { deny?: string[]; allow?: string[] } {
  const list = (v: string | undefined): string[] | undefined => (v ? v.split('\u0000').filter(Boolean) : undefined);
  const deny = list(labels?.['husk.denyCommands']);
  const allow = list(labels?.['husk.allowCommands']);
  return { ...(deny ? { deny } : {}), ...(allow ? { allow } : {}) };
}

/** A Python string literal, any prefix (r, b, f) and any quotes. */
const PY_STRING = String.raw`(?:[rRbBuUfF]{1,2})?(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")`;
/** A Python call that hands a shell or a program a command, its first argument written out: a string, or a list of strings. */
const SHELL_CALL = new RegExp(
  String.raw`\b(?:os\.(?:system|popen)|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput))\s*\(\s*(\[[^\]]*\]|${PY_STRING})`,
  'g',
);
const STRING_TEXT = new RegExp(String.raw`(?:[rRbBuUfF]{1,2})?(?:'''([\s\S]*?)'''|"""([\s\S]*?)"""|'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)")`, 'g');

/**
 * Whether a browser script may run, by the rules `shell` gets.
 *
 * Those rules read shell command lines, and a script is Python: read as one,
 * `halt = False` would be a power-off, and so would `print("shutdown
 * complete")`. So what is checked is what a script hands a shell or a
 * program where it is written out -- `os.system("...")`,
 * `subprocess.run(["rm", "-rf", "/"])` -- each read as the command line it is.
 * A guardrail, as the rules are for `shell`: a command a script builds from
 * pieces is not read, and the computer stays the boundary.
 */
export function evaluateScript(source: string, opts: Parameters<typeof evaluateCommand>[1] = {}): PolicyDecision {
  for (const call of source.matchAll(SHELL_CALL)) {
    const words = [...(call[1] ?? '').matchAll(STRING_TEXT)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
    const decision = evaluateCommand(words.join(' '), opts);
    if (!decision.allowed) return decision;
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
