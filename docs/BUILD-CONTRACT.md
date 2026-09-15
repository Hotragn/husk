# Husk — build contract

Read this before writing a line. Every package in this monorepo obeys it.

## What Husk is

**Husk gives any AI agent a computer, and turns any AI chat into a bot.**

Two jobs, one runtime:

1. **A computer for agents.** A small, disposable Linux machine an agent can drive —
   shell, filesystem, ports, snapshots. It must work for free on the user's own
   hardware (Docker, Podman, or a guarded local directory) and optionally on a remote
   box they already have (SSH, Fly).
2. **A chat becomes a bot.** Import a transcript (Claude Code, ChatGPT, Cursor,
   markdown), distill it into a `husk.yaml`, and serve it as a bot over HTTP, CLI,
   Discord, Slack, Telegram, or cron.

The bridge is MCP: `claude mcp add husk -- npx -y @husk-ai/mcp` gives Claude Code
(or any MCP client) a computer immediately, with no account and no signup.

## Non-negotiables

- **Free path must work.** No API key, no Docker, no account: `husk` still runs, using
  the `local` provider and an Ollama model. Every feature degrades, none hard-fails.
- **Honest isolation.** `local` is guardrails, not a sandbox. Say so in the code, in
  `husk doctor`, and in the docs. Never imply containment we do not provide.
- **No telemetry.** Nothing leaves the machine except calls to the model provider the
  user configured. There is no phone-home, no analytics, no crash reporter.
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
                               openrouter, ollama, lmstudio, deepseek, mistral, cerebras
  sessions/   @husk-ai/sessions   transcript importers + the distiller (chat -> husk.yaml)
  agent/      @husk-ai/agent      the tool-calling loop + the built-in tools
  mcp/        @husk-ai/mcp        MCP server (stdio)
  server/     @husk-ai/server     control plane REST/WS + bot host
  adapters/   @husk-ai/adapters   discord / slack / telegram / webhook front ends
  sdk/        @husk-ai/sdk        typed client for the control plane
  cli/        @husk-ai/cli        the `husk` binary
apps/
  web/        @husk-ai/web        marketing site + docs (Next.js, three.js)
  console/    @husk-ai/console    dashboard: live terminal, files, playground (Vite)
sandbox/                       Dockerfiles for the husk images
brand/                         brand kit
```

**Dependency direction is strictly downhill.** `core` <- `runtime`/`models`/`sessions`
<- `agent` <- `mcp`/`server`/`adapters` <- `cli`. Never import sideways or upward.
Never import from another package's `src/` — always the package name.

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

If a contract is genuinely wrong, say so in your report — do not silently widen it.

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
| `local` | first available Ollama model |
| `free` | best free-tier model that is actually reachable |
| `auto` | best available, preferring quality then cost |

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

Every package therefore has two configs:

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

`isHostAllowed` refuses loopback, link-local, and RFC1918 hosts **even in
`network.mode: 'full'`**, unless the operator names them in `allow`. `mode: 'full'` means
the internet, not the cloud metadata service at `169.254.169.254` that hands IAM
credentials to anything that asks. Both `@husk-ai/runtime` and `@husk-ai/agent` enforce this.
