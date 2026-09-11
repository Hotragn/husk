import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * `@husk/sdk` pulls `@husk/core`'s barrel, which re-exports two Node-only
 * modules (`config.js`, `ids.js`). Without these aliases the bundle throws on
 * import in the browser. See `src/shims/node-builtins.ts` for the detail and
 * for why this is an upstream bug, not a console one.
 */
const nodeShim = fileURLToPath(new URL('./src/shims/node-builtins.ts', import.meta.url));

/**
 * In production `@husk/server` serves this bundle from its own origin
 * (`packages/server/src/console.ts` looks for `apps/console/dist`), so the app
 * talks to `/v1` on `window.location.origin` and there is no CORS to arrange.
 *
 * In development the dev server is a different origin, and the control plane
 * sets `corsOrigins: false` by default — it is a loopback daemon and it is
 * right not to hand out CORS headers. Proxying keeps development on the same
 * origin as production rather than asking the server to relax for us. `ws: true`
 * carries the terminal and event sockets through the same hop.
 *
 * `HUSK_URL` overrides the target when the daemon is not on the default port.
 */
const target = process.env.HUSK_URL ?? 'http://127.0.0.1:7377';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^node:crypto$/, replacement: nodeShim },
      { find: /^node:os$/, replacement: nodeShim },
      { find: /^node:fs$/, replacement: nodeShim },
      { find: /^node:path$/, replacement: nodeShim },
    ],
  },
  optimizeDeps: {
    // The workspace link means Vite would otherwise pre-bundle @husk/sdk and
    // bake the unaliased node: imports into the dep cache.
    exclude: ['@husk/sdk'],
  },
  server: {
    proxy: {
      '/v1': { target, changeOrigin: true, ws: true },
      '/health': { target, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // xterm is the only heavyweight dependency. Splitting it means Doctor
        // and Computers do not pay for a terminal nobody opened.
        manualChunks: (id: string) => (id.includes('@xterm') ? 'xterm' : undefined),
      },
    },
  },
});
