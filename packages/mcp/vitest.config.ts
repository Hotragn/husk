import { defineConfig } from 'vitest/config';

// No test may start the machine's shared Husk: tools run in-process here, and
// the daemon path is covered with injected fakes in daemon.test.ts.
export default defineConfig({ test: { env: { HUSK_DAEMON: 'off' } } });
