#!/usr/bin/env node
import { installSignalHandlers, main } from './cli.js';
import { EXIT_OK, EXIT_SIGINT } from './exit.js';
import { renderError } from './render-error.js';
import { wasInterrupted } from './signal.js';

/**
 * `husk`.
 *
 * This file is what `package.json#bin` points at, and it runs on import with no
 * condition attached. There used to be a `bin/husk` wrapper that imported the
 * compiled version of this file, plus an `isEntrypoint()` check here comparing
 * `process.argv[1]` to `import.meta.url` -- which through a wrapper can never
 * match, so every `npx @husk-ai/cli` in 0.1.1 exited 0 having done nothing.
 *
 * The wrapper existed to carry the shebang. It did not need to: tsc emits the
 * shebang above into `dist/bin.js` already, which is why `@husk-ai/mcp` points
 * its bin straight at `dist/bin.js` and has always worked.
 *
 * Two rules keep it fixed. Nothing may import this module -- the helpers live in
 * `cli.ts` and `index.ts` re-exports from there -- and `bin` must name this file,
 * which `smoke.test.ts` now reads from package.json rather than assuming.
 */

installSignalHandlers();

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = wasInterrupted() && code === EXIT_OK ? EXIT_SIGINT : code;
  })
  .catch((err: unknown) => {
    if (wasInterrupted()) {
      process.exitCode = EXIT_SIGINT;
      return;
    }
    process.exitCode = renderError(err);
  });
