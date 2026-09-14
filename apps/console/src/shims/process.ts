/**
 * A minimal `process` global, installed before anything imports `@husk-ai/sdk`.
 *
 * `@husk-ai/core`'s barrel ends with:
 *
 *   export const log = createLogger({ scope: 'husk' });
 *
 * and `createLogger` reads `process.env.HUSK_LOG_LEVEL`,
 * `process.env.HUSK_LOG_JSON`, `process.stderr.isTTY` and captures
 * `process.stderr.write` as its default sink — all at module-evaluation time.
 * Because every `@husk-ai/sdk` module imports that barrel, the browser throws
 * `ReferenceError: process is not defined` before the console renders a pixel.
 *
 * Verified against @husk-ai/core 0.1.0. Like `node-builtins.ts`, this belongs
 * upstream: a contracts package should not construct a stderr logger as a side
 * effect of being imported. Until it stops doing that, the console supplies the
 * three fields that logger touches and nothing more.
 *
 * `stderr.write` forwards to `console.debug` rather than being swallowed — if
 * something in the SDK ever logs, a developer should be able to see it.
 */

interface MinimalProcess {
  env: Record<string, string | undefined>;
  stderr: { isTTY: boolean; write(chunk: string): boolean };
  platform: string;
  version: string;
}

declare global {
  // eslint-disable-next-line no-var
  var process: MinimalProcess | undefined;
}

if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    // No secrets from a bundler here. The console reads its base URL and token
    // from localStorage, not from a baked-in environment.
    env: {},
    stderr: {
      isTTY: false,
      write(chunk: string): boolean {
        console.debug(chunk.replace(/\n$/, ''));
        return true;
      },
    },
    platform: 'browser',
    version: '',
  };
}

export {};
