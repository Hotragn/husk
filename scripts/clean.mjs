import { rm } from 'node:fs/promises';
import { globSync } from 'node:fs';
const targets = globSync(['packages/*/dist', 'apps/*/dist', 'apps/*/.next', '**/*.tsbuildinfo'], {
  exclude: (p) => p.includes('node_modules'),
});
await Promise.all(targets.map((t) => rm(t, { recursive: true, force: true })));
console.log(`cleaned ${targets.length} path(s)`);
