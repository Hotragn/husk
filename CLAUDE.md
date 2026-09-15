# Husk

TypeScript monorepo — 11 npm packages + 3 apps giving AI agents disposable Linux computers.

## Build & test

```bash
npm install
npm run build       # explicit topological order, not npm workspaces default
npm run typecheck   # all workspaces
npm test            # all workspaces (vitest)
```

`apps/docs` and `apps/web` are outside the workspace — own lockfiles, `cd` in and
`npm install` on demand. A root `npm install` covers `packages/*` and `apps/console` only.

Single package:

```bash
npm run build -w @husk-ai/core
npm test -w @husk-ai/core
```

## Architecture

Dependencies flow downhill: `core` <- `runtime`/`models`/`sessions` <- `browser` <- `agent` <- `adapters`/`mcp`/`server`/`sdk` <- `cli`. Never sideways, never up.

## Conventions

- ESM only. NodeNext resolution. Relative imports carry `.js`.
- No native modules. Windows `npm install` must work without a C++ toolchain.
- Two tsconfigs per package: `tsconfig.json` (typecheck), `tsconfig.build.json` (build).
- Tests are colocated as `src/**/*.test.ts`. All tests pass with no Docker, no API key, no network.
- Errors use `HuskError` with a code and a `hint` naming the fix.
- The `local` provider is guardrails only, not a sandbox. Never claim isolation that isn't provided.
- `GUEST_ROOT = '/work'` is the canonical guest working directory (defined in `packages/runtime/src/policy.ts`).
- Root `overrides` in package.json pins React to 19.2.8 and Zod to 3.25.76. The two
  out-of-workspace sites pin React themselves, exactly, since the override cannot reach them.
