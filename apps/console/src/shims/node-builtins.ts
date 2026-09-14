/**
 * Browser shims for the four Node built-ins `@husk-ai/core` reaches for.
 *
 * `@husk-ai/sdk` is described as "dependency-free: global `fetch`, and
 * `@husk-ai/core` for the shared contracts", and its own code is genuinely
 * browser-safe. But every SDK module imports from `@husk-ai/core`'s barrel, and
 * that barrel re-exports `config.js` (`node:os`, `node:fs`, `node:path`) and
 * `ids.js` (`node:crypto`). Those are *value* imports evaluated at module load,
 * so a browser bundle throws on `import { HuskClient } from '@husk-ai/sdk'`
 * before a line of console code runs. Verified against 0.1.0:
 *
 *   Uncaught: Module "node:crypto" has been externalized for browser
 *   compatibility. Cannot access "node:crypto.randomBytes" in client code.
 *
 * The fix belongs upstream — core should split its Node-only surface out of
 * the barrel, or the SDK should import `HuskError` from a leaf module. Until
 * then this file keeps the fix inside `apps/console`, which is the only
 * directory this change is allowed to touch.
 *
 * The rule for what goes in here: implement it correctly where the browser can
 * (`randomBytes` is `crypto.getRandomValues`), and throw a named error where it
 * cannot. A silent stub that returns `'/'` for a home directory would be the
 * dishonest option, and none of these are on any path the console takes.
 */

function unavailable(module: string, fn: string): never {
  throw new Error(
    `${module}.${fn}() is not available in the browser. The Husk console reached a Node-only code path in ` +
      `@husk-ai/core; nothing in the console should call it. Report this rather than working around it.`,
  );
}

// -- node:crypto --------------------------------------------------------------

/** A real implementation. `@husk-ai/core`'s `id()` only needs random bytes. */
export function randomBytes(size: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

// -- node:os ------------------------------------------------------------------

export function homedir(): string {
  return unavailable('node:os', 'homedir');
}

// -- node:path ----------------------------------------------------------------

export function join(...parts: string[]): string {
  void parts;
  return unavailable('node:path', 'join');
}

export function resolve(...parts: string[]): string {
  void parts;
  return unavailable('node:path', 'resolve');
}

// -- node:fs ------------------------------------------------------------------

export function existsSync(path: string): boolean {
  void path;
  return unavailable('node:fs', 'existsSync');
}

export function mkdirSync(path: string, options?: unknown): string | undefined {
  void path;
  void options;
  return unavailable('node:fs', 'mkdirSync');
}
