# Husk — architecture

## The two sentences

A **computer** is a disposable Linux machine an agent can drive. A **husk** is an agent
definition — a `husk.yaml` — that can be run against one. Everything in this repo exists
to make those two things cheap, portable, and free.

## Why it is shaped this way

Three constraints drove every structural decision.

**1. The free path has to be the default path, not a degraded mode.** Most agent-sandbox
products start at a hosted control plane and bolt on a local option later. That inverts
the trust and cost story for the people most likely to try this: someone with no budget
and a laptop. So the primitive is a local provider, the hosted providers are plugins
behind the same interface, and there is no code path that requires an account.

**2. The isolation guarantee varies by machine, so it has to be a first-class value, not
an assumption.** Docker gives kernel isolation. A guarded directory does not. Pretending
otherwise is the kind of lie that ends up in an incident report. `Availability.isolated`
is on the provider interface, `husk doctor` prints it, and the docs say it plainly.

**3. An agent must not know where it is running.** If the shell tool behaves differently
on Docker versus SSH versus Fly, every husk becomes provider-specific and the abstraction
is worthless. So `Computer` is a narrow, complete interface, and translation lives
entirely in the provider.

## Layers

```
                       ┌──────────────────────────────────────────┐
   Claude Code ───────▶│  @husk/mcp        stdio + streamable HTTP│
   Cursor, Zed         └────────────────────┬─────────────────────┘
   any MCP client                           │
                       ┌────────────────────▼─────────────────────┐
   HTTP / Discord ────▶│  @husk/server     control plane + bots   │
   Slack / cron        └────────────────────┬─────────────────────┘
                       ┌────────────────────▼─────────────────────┐
   husk run ──────────▶│  @husk/agent      the tool-calling loop  │
                       └───┬──────────────────────────┬───────────┘
                           │                          │
        ┌──────────────────▼──────┐      ┌────────────▼─────────────┐
        │ @husk/runtime           │      │ @husk/models             │
        │ docker podman local     │      │ anthropic openai google  │
        │ ssh fly                 │      │ groq ollama openrouter   │
        └─────────────────────────┘      └──────────────────────────┘
                           │                          │
                       ┌───▼──────────────────────────▼───────────┐
                       │ @husk/core   contracts, spec, primitives │
                       └──────────────────────────────────────────┘

   @husk/sessions  transcript ──▶ husk.yaml    (feeds the layers above, depends on core)
```

Dependencies run strictly downhill. `core` imports nothing from the workspace. Nothing
imports `cli`.

## The computer

### Provider selection

`ComputerManager.resolveProvider('auto')` probes in priority order and takes the first
that answers. Probes are cached for 30 seconds because `docker version` on a cold daemon
takes ~800 ms and an agent may create four machines in a row.

| provider | `isolationKind` | cost | when it wins |
| --- | --- | --- | --- |
| `docker` | `kernel` — namespaces, cgroups, seccomp | free, local | the default when Docker is up |
| `podman` | `kernel`, rootless | free, local | Linux without a Docker daemon |
| `ssh` | `machine` — a different computer | free if you own the box | an Oracle Always Free ARM box, a Pi, a VPS |
| `fly` | `kernel` — microVM | metered | bursty parallel work, no local resources |
| `local` | `guardrails` — **process checks only** | free, local | nothing else is available |

`isolationKind` exists because a boolean lied. An `ssh` computer is genuinely
isolated from your laptop, so `isolated: true` is correct — but the agent still
holds your user's shell on the far end, and a green "isolated" badge invited
exactly the wrong conclusion. Three named kinds let `husk doctor` say "isolated
from this machine" instead, which is the true sentence.

### What "guarded, not isolated" means

The `local` provider pins `cwd` to a workspace directory, resolves every path through
`realpath` and rejects escapes, scrubs credential-shaped environment variables, caps
output bytes, kills the process tree on timeout, and refuses a deny list of genuinely
destructive commands. That stops accidents. It does not stop a determined adversary, and
a model that has been prompt-injected is closer to an adversary than to an accident. The
provider reports `isolated: false` and the CLI says so on first use.

### Lifecycle

Create is lazy — nothing is spun up until a tool actually needs a machine. `ensure(key,
spec)` maps a stable key (a Claude Code session id, a husk name) to a machine, so a
conversation keeps the same filesystem across tool calls without the caller tracking ids.
A reaper honours `idleTimeoutSec` and `maxLifetimeSec`; metadata is JSON under
`~/.husk/computers/` written with write-then-rename, so `husk ps` works from another
process and a crash mid-write cannot corrupt the registry.

## The model router

One `ModelProvider` interface, ten implementations, no SDK dependencies — the wire-format
translation *is* the package. Aliases (`opus`, `sonnet`, `gemma`, `free`, `auto`) resolve
to `provider/model` so a `husk.yaml` written against Ollama runs against Opus by changing
one line.

Fallback is the part that matters in practice. A 429 from Anthropic, a dead Ollama, an
expired key: the router walks the husk's `fallbackModels`, then its own preference order,
retrying with full-jitter backoff, never retrying a 400 or 401. It emits a `warning`
event when it falls back, because silently answering with a weaker model is worse than
failing.

Cost is estimated before the call from a static price catalog and computed after from
real usage. Local models are zero, and the router knows it.

## The agent loop

A conventional tool-calling loop with the boring parts done properly: step ceiling,
cost ceiling, token ceiling, wall-clock timeout, abort propagation into the underlying
fetch and into the underlying `docker exec`, tool output clamped and passed through
`redact()` before it re-enters the conversation, and an approval hook so `ask` mode can
gate a dangerous call on a human.

Tools are bundles: `computer` (shell, ports, snapshot), `files` (read, write, edit, list,
search), `web` (fetch, search), `http` (arbitrary request). A husk lists the bundles it
wants; the loop assembles the schema list from that.

## chat → bot

```
transcript ──▶ importer ──▶ Transcript ──▶ distiller ──▶ DistilledAgent ──▶ husk.yaml
```

Importers normalise Claude Code JSONL, ChatGPT exports, Cursor, and pasted markdown into
one `Transcript`. Branched threads are reconstructed by walking `parentUuid` from the last
leaf, so you get the conversation as it actually ran, not every dead end.

The distiller has two modes and the heuristic one has to be good, because it is the mode
that runs with no API key: it mines recurring instructions for the persona, picks
exemplars the user did *not* correct, derives the tool set from observed tool usage, and
reports an honest confidence with notes on what it could not determine. The model-backed
mode does the same job better via a map/reduce over windows, validates its JSON against
the schema, and falls back to the heuristic rather than failing.

Output is a `husk.yaml` a human can read, diff, and edit. That file is the product's unit
of value, so it is optimised for review, not for machines: deliberate key order, block
scalars, a provenance header naming the transcript it came from.

## Serving

A husk becomes a bot through triggers declared in its spec: `http`, `cron`, `discord`,
`slack`, `telegram`, `webhook`, `cli`. `@husk/server` hosts them on one Fastify process
with a JSON-file store (no native modules — a Windows `npm install` must be clean), and
`@husk/adapters` holds the per-platform front ends.

## MCP: the wedge

```bash
claude mcp add husk -- npx -y @husk/mcp
```

That is the whole onboarding for the largest audience. `@husk/mcp` exposes the computer
as MCP tools over stdio, so Claude Code — or Cursor, or Zed, or anything speaking MCP —
gets a Linux machine mid-conversation with no account, no config file, and no signup. The
same server runs over streamable HTTP for remote clients.

## Deliberate non-goals

- **No GPU orchestration.** Different product, different economics.
- **No multi-tenant hosted control plane in v1.** The single-user local daemon is the
  product; a hosted tier can wrap it later without changing these interfaces.
- **No native dependencies, ever.** One `npm install` failing on a Windows machine
  without a C++ toolchain costs more users than SQLite saves.
- **No telemetry.** Not "off by default" — absent.
