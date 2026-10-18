import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * In production `@husk-ai/server` serves this bundle from its own origin
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
