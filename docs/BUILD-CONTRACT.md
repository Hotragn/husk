# Husk — build contract

Read this before writing a line. Every package in this monorepo obeys it.

## What Husk is

**Husk gives any AI agent a computer, and turns any AI chat into a bot.**

Two jobs, one runtime:

1. **A computer for agents.** A small, disposable Linux machine an agent can drive —
   shell, filesystem, ports, a browser. It must work for free on the user's own
   hardware (Docker, Podman, or a guarded local directory) and optionally on a remote
   box they already have (SSH, Fly).
2. **A chat becomes a bot.** Import a transcript (Claude Code, Codex, ChatGPT, Cursor,
   Gemini, markdown), distill it into a `husk.yaml`, and serve it as a bot over HTTP,
   a webhook, CLI, Discord, Slack, Telegram, or cron.

The bridge is MCP: `claude mcp add husk -- npx -y @husk-ai/mcp` gives Claude Code
(or any MCP client) a computer immediately, with no account and no signup.

## Non-negotiables

- **Free path must work.** No API key, no Docker, no account: `husk` still runs, using
  the `local` provider and an Ollama model. Every feature degrades, none hard-fails.
- **Honest isolation.** `local` is guardrails, not a sandbox. Say so in the code, in
  `husk doctor`, and in the docs. Never imply containment we do not provide.
- **No telemetry.** There is no phone-home, no analytics, no crash reporter. What leaves
  the machine is the user's own work: calls to the model provider they configured, the
  pages, searches and remote computers a task reaches, image pulls, and, with remote
  access on, the names and versions of Husk's packages, sent to the npm registry to ask
  for advisories.
- **Secrets never reach a model.** Tool output passes through `redact()` from
  `@husk-ai/core` before it is added to the conversation.
- **Every error is actionable.** Throw `HuskError` with a `code` and a one-line `hint`
  that says what to do next.

## Repo layout

```
packages/
  core/       @husk-ai/core       contracts + primitives. Depends on nothing but zod.
  runtime/    @husk-ai/runtime    computer providers: docker, podman, local, ssh, fly
  models/     @husk-ai/models     model router: anthropic, openai, google, groq,
                               openrouter, together, ollama, lmstudio, deepseek,
                               mistral, cerebras
  sessions/   @husk-ai/sessions   transcript importers + the distiller (chat -> husk.yaml)
  browser/    @husk-ai/browser    a real Chromium inside a computer, driven over CDP
  agent/      @husk-ai/agent      the tool-calling loop + the built-in tools
  workspaces/ @husk-ai/workspaces named local workspaces: sources, results, export
  mcp/        @husk-ai/mcp        MCP server: stdio for chat apps, the shared Husk every
                               chat forwards to, and remote access's /mcp
  server/     @husk-ai/server     control plane REST/WS + bot host
  adapters/   @husk-ai/adapters   discord / slack / telegram / webhook front ends
  sdk/        @husk-ai/sdk        typed client for the control plane
  console-assets/ @husk-ai/console-assets  the built console, served by server
  cli/        @husk-ai/cli        the `husk` binary
apps/
  console/    @husk-ai/console    dashboard: live terminal, files, playground (Vite)
  desktop/    husk-desktop        the desktop app (Electron)
  mac/                         Husk Bar, a macOS menu-bar companion (Swift)
  docs/       @husk-ai/docs       documentation site (Next.js + MDX)
  web/        @husk-ai/web        marketing site (Next.js, three.js)
sandbox/                       optional Dockerfiles for anyone who builds their own images
brand/                         brand kit
```

### Dependency direction

**Strictly downhill.** Never import sideways or upward, and never from another package's
`src/` — always the package name.

| Layer | Packages | May depend on |
| --- | --- | --- |
| 0 | `core`, `console-assets` | nothing in the workspace |
| 1 | `runtime`, `models`, `sessions`, `browser`, `workspaces`, `sdk`, `adapters` | layer 0 |
| 2 | `agent` | layers 0–1 |
| 3 | `server` | layers 0–2 |
| 4 | `mcp` | layers 0–3 |
| 5 | `cli` | layers 0–4 |

The layer is a ceiling, not a requirement: `adapters`, `workspaces` and `sdk` sit at
layer 1 because `core` is all they need, and `console-assets` is the built console, with
no code that imports anything. `server` depends on every package below it; it loads
`agent` with a dynamic import, so the control plane still starts on a tree where the
agent was never built. `mcp` sits above `server` because the shared Husk, the workspace
viewer and remote access's `/mcp` are built on it. `cli` declares `mcp`, `server` and
`sdk` as optional dependencies, and loads the first two with a dynamic import. Nothing
depends on `cli`.

This table is the only copy of the ordering. It was previously written as a linear chain
in three files, and all three had drifted — `browser` was missing from every one of
them, and `adapters` and `sdk` were shown above `agent` when neither imports it.

**Two tests reach upward, on purpose.** `packages/sdk/src/contract.test.ts` imports
`@husk-ai/server` and `@husk-ai/runtime`, which sit above it. That is the whole point of
the test: it boots the real server on a real socket with a real `LocalProvider` and
drives every public `HuskClient` method over real HTTP and a real WebSocket, because a
mocked `fetch` once let the SDK ship twelve methods pointed at routes that did not
exist. `packages/sdk/src/conformance.test.ts` also imports `@husk-ai/mcp`, to check that
`/work/x` names the same file through every surface. The edges are `devDependencies`, so
they are absent from anything published, and they are written down here rather than left
to npm's hoisting to arrange quietly.

## Conventions

- TypeScript, ESM only (`"type": "module"`). Relative imports **must** carry the `.js`
  extension (NodeNext resolution).
- Target Node >= 20.10. Use built-ins over dependencies: `node:util`'s `parseArgs`,
  global `fetch`, `node:test` or vitest, `AbortSignal`. Add a dependency only when
  writing it yourself would be irresponsible.
- **No native modules.** No `better-sqlite3`, no `node-pty`, no anything needing a
  C++ toolchain. Windows users must get a clean `npm install`. Persist state as JSON
  files under `paths()` from `@husk-ai/core`.
- Each package: `package.json` (name, the same version as the root manifest, license
  Apache-2.0, type module, main/types/exports pointing at `dist`, `files: ["dist"]`,
  scripts `build`, `typecheck`, `test`), `tsconfig.json` extending
  `../../tsconfig.base.json` with `outDir: dist`, `rootDir: src`, and `src/index.ts`
  as the only public surface.
- Workspace deps pin that exact version, never a range and never `workspace:*` — npm
  workspaces links them.
- Root `overrides` pins `react` and `react-dom` to 19.2.8 and `zod` to 3.25.76, so a
  transitive dependency cannot pull in a second copy. The one exception is deliberate:
  the MCP SDK (`@modelcontextprotocol/core`, `server` and `client`) needs zod 4, and its
  override gives it `^4.2.0`, so that second copy is there by design. An override only
  reaches the workspace, so `apps/docs` and `apps/web` pin React themselves, at the
  same exact versions — nothing links those two pins to this one.
- `strict` is on, and so is `noUncheckedIndexedAccess`. Index access yields `T |
  undefined`; handle it, do not blanket-assert.
- Comments explain *why*. No comment restates the line below it. No section banners.
- Tests with vitest, colocated as `src/**/*.test.ts`. Test the logic that would
  silently rot: parsers, policy decisions, retry and budget math, format translation.
  Do not write tests that assert a mock was called.

## The contracts (already written, do not change)

Import these from `@husk-ai/core`:

- `ComputerProvider`, `Computer`, `ComputerSpec`, `ExecRequest`, `ExecResult`,
  `NetworkPolicy`, `Availability` — the computer surface.
- `ModelProvider`, `ChatRequest`, `ChatResponse`, `StreamEvent`, `ModelInfo`,
  `ModelMessage`, `ToolSchema` — the model surface.
- `Tool`, `ToolContext`, `RunOptions`, `RunEvent`, `RunResult` — the agent surface.
- `TranscriptImporter`, `Transcript`, `DistilledAgent` — the import surface.
- `HuskSpec`, `parseSpec`, `defaultSpec`, `renderPersona` — the `husk.yaml` schema.
- `HuskError`, `createLogger`, `paths()`, `ensurePaths()`, `redact()`, `retry()`,
  `clampText()`, `mapLimit()`, `id()`, `slug()`.

If a contract is genuinely wrong, say so in a PR or an issue — do not silently widen it.

`GUEST_ROOT = '/work'` is the canonical working directory inside a computer, on every
provider. It is defined in `packages/runtime/src/policy.ts` and exported from
`@husk-ai/runtime`. Paths in tool arguments, in the path jail and in a `husk.yaml` all
resolve against it, so a provider that put the workspace elsewhere would make specs
provider-specific. Import it rather than writing `/work`.

Two copies are unavoidable, both in `core`, which cannot import from `runtime` above it:
`GUEST_WORKDIR` in `core/src/computer-info.ts`, marked with a comment naming its
counterpart, and the default of `computer.workdir` in `core/src/spec.ts`. Neither is yet
one of the drift check's assertions, which is the only reason they could disagree with
`GUEST_ROOT` without anyone hearing about it.

## Model aliases (canonical, used everywhere)

| alias | resolves to |
| --- | --- |
| `opus` | `anthropic/claude-opus-5` |
| `sonnet` | `anthropic/claude-sonnet-5` |
| `haiku` | `anthropic/claude-haiku-4-5-20251001` |
| `gpt` | `openai/gpt-4.1` |
| `gemini` | `google/gemini-2.5-pro` |
| `flash` | `google/gemini-2.5-flash` |
| `gemma` | `ollama/gemma3` |
| `llama` | `ollama/llama3.2` |
| `qwen` | `ollama/qwen2.5-coder` |
| `local` | a model on a running Ollama or LM Studio |
| `free` | best free-tier model that is actually reachable |
| `auto` | best available model, by tool support and then quality |

## Definition of done, per package

- `npm run typecheck` passes with zero errors.
- `npm run build` emits `dist/`.
- `npm run test` passes.
- The package's `README.md` shows one real, runnable example.
- No `TODO`, no `throw new Error('not implemented')` in a shipped code path. If a
  capability is genuinely out of scope, the method is absent and callers feature-detect.

## Packaging: never ship tests

Colocated `src/**/*.test.ts` plus `include: ["src"]` plus `files: ["dist"]` means the
published tarball contains compiled test files that `import 'vitest'` — an undeclared
runtime dependency that breaks on install.

Every TypeScript package therefore has two configs. (`console-assets` has none: it holds
the built console and builds with `node build.mjs`.)

- `tsconfig.json` — includes everything, used by `npm run typecheck`.
- `tsconfig.build.json` — `"exclude": ["**/*.test.ts", "**/test-support.ts"]`, used by
  `npm run build`.

```json
"scripts": {
  "build": "tsc -p tsconfig.build.json",
  "typecheck": "tsc -p tsconfig.json --noEmit"
}
```

Verify with `ls packages/<name>/dist/*.test.js` — it must find nothing.

## Network floor

`isHostAllowed`, in `@husk-ai/core`, refuses loopback, link-local, and RFC1918 hosts
**even in `network.mode: 'full'`**, unless the operator names them in `allow`.
`mode: 'full'` means the internet, not the cloud metadata service at `169.254.169.254`
that hands IAM credentials to anything that asks. Loopback is allowed where the computer
has its own: docker, podman and fly.

Husk's own tools and the browser driver's page loads ask it. Nothing firewalls a process
in the computer, so a shell's `curl` is never checked; only `none` on docker or podman,
which runs the container with no network, stops one. `docs/SECURITY-MODEL.md` has the
matrix.
