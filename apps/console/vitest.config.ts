import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vite.config';

/**
 * The console's tests are components, so they run in jsdom and reuse the build
 * config wholesale — the react plugin for JSX, and the `node:` aliases that
 * `@husk-ai/sdk` needs to be importable outside Node.
 */
export default mergeConfig(
  base,
  defineConfig({
    // Explicit rather than inherited from the react plugin: when the root
    // `vitest.workspace.ts` runs this project, plugin resolution does not
    // reliably reach esbuild's JSX setting, and classic-runtime output fails
    // with "React is not defined".
    esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
    test: {
      environment: 'jsdom',
      // jsdom has no canvas and xterm wants one; see the file for what it stubs
      // and what it deliberately does not.
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      // These poll React until the promise chains settle. The default 5s is
      // enough on an idle machine and not enough when the whole repo suite is
      // running in parallel beside them.
      testTimeout: 30_000,
    },
  }),
);
