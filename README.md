<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo/lockup-horizontal.svg">
    <source media="(prefers-color-scheme: light)" srcset="brand/logo/lockup-horizontal.svg">
    <img src="brand/logo/lockup-horizontal.svg" alt="Husk" height="72">
  </picture>

  <p><strong>Give your AI chat a real computer of its own.</strong></p>

  <p>
    <a href="https://github.com/Hotragn/husk/actions/workflows/ci.yml"><img src="https://github.com/Hotragn/husk/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://www.npmjs.com/package/@husk-ai/cli"><img src="https://img.shields.io/npm/v/@husk-ai/cli?label=npm&color=cb3837" alt="npm"></a>
    <img src="https://img.shields.io/badge/status-alpha-orange" alt="Status: Alpha">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
    <a href="https://github.com/Hotragn/husk/stargazers"><img src="https://img.shields.io/github/stars/Hotragn/husk?style=social" alt="GitHub stars"></a>
  </p>
</div>

Husk gives your AI chat a real computer of its own: files, a browser, and somewhere to run code. It can build things, look stuff up online and keep your work between chats. Turn a chat you already had into a bot that does the job again tomorrow.

Free to start. Runs on your hardware. No account required.

> [!NOTE]
> Husk is in **early alpha** — everything works, things are moving fast, and your feedback shapes what comes next. [Jump in](https://github.com/Hotragn/husk/discussions).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/png/01-hero.dark.png">
  <img alt="A chat client talks to @husk-ai/mcp over stdio, which asks @husk-ai/runtime for a computer holding /work, a shell and Chromium" src="docs/diagrams/png/01-hero.light.png">
</picture>

<sub>[Open interactively](docs/diagrams/01-hero.html) — pan, zoom, trace relationships · [SVG](docs/diagrams/svg/01-hero.light.svg) · [all 16 diagrams](docs/diagrams/)</sub>

## Quick start

```bash
npx @husk-ai/cli doctor            # what's available on this machine
npx @husk-ai/cli up dev            # spin up a Linux computer
npx @husk-ai/cli exec dev -- 'uname -sr && python3 -V'
npx @husk-ai/cli rm dev            # tear it down
```

No Docker? It still works — [see what each provider gives you](#isolation).

### Give Claude Code a computer

```bash
claude mcp add husk -- npx -y @husk-ai/mcp
```

One command. Claude Code gets `shell`, `read_file`, `write_file`, `list_dir` and `expose_port` against a real Linux machine — sandboxed away from your repo, filesystem persisting across the conversation. Works with Cursor, Zed, or anything that speaks MCP.

### Turn a chat into a bot

```bash
husk import                      # finds Claude Code / ChatGPT transcripts
husk distill 3 --out triage.yaml # conversation → agent spec
husk run triage.yaml "check the build"
```

What comes out is a YAML file you can read and version:

```yaml
name: triage
model: sonnet
persona: |
  You triage CI failures for a TypeScript monorepo.
  Always read the failing job log before guessing.
tools: [computer, files]
computer:
  flavor: node
  network: { mode: egress, allow: ['*.github.com'] }
limits: { maxSteps: 24, maxCostUsd: 0.25 }
```

Here is what happens between the transcript and the YAML:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/png/04-chat-to-bot.dark.png">
  <img alt="Sequence: transcript to importer to distiller, optionally via the model router, then redaction, husk.yaml and husk run" src="docs/diagrams/png/04-chat-to-bot.light.png">
</picture>

Importers normalise Claude Code JSONL, ChatGPT, Cursor, Gemini and markdown into one `Transcript` — branched threads are rebuilt by walking `parentUuid` back from the last leaf. The heuristic distiller runs with no API key, and the model-backed mode falls back to it rather than failing. Secrets are stripped before the file is written, not after.

<sub>[Open interactively](docs/diagrams/04-chat-to-bot.html) · [SVG](docs/diagrams/svg/04-chat-to-bot.light.svg)</sub>

## Why Husk

| What you get | What that means |
| --- | --- |
| **A real computer per chat** | Files, shell, browser, ports — not a code interpreter, an actual Linux machine |
| **Five providers, one interface** | Docker, Podman, local, SSH, Fly — highest available wins automatically |
| **Works with what you have** | No Docker? No API key? No account? It still runs |
| **Chat-to-bot pipeline** | Import a transcript, distill it to YAML, run it tomorrow |
| **10+ model providers** | Ollama, Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, Together, LM Studio |
| **MCP server** | One line to give any MCP client a sandboxed computer |
| **Adapters built in** | Discord, Slack, Telegram, webhook — out of the box |
| **Browser automation** | Chromium lifecycle, CDP, screenshots, click/type/scroll |
| **No telemetry** | Not "off by default" — absent. No analytics, no crash reporter, no phone-home |
| **No native modules** | `npm install` is clean on Windows without a C++ toolchain |

## Models

Bring whatever you have. Aliases resolve across providers so the same husk runs on Opus or on a local Gemma.

| Tier | Providers |
| --- | --- |
| **Free, local** | Ollama (`gemma`, `llama`, `qwen`), LM Studio |
| **Free tier** | Groq, Google AI Studio, OpenRouter `:free` models, Cerebras |
| **Paid** | Anthropic (`opus`, `sonnet`, `haiku`), OpenAI, Google, DeepSeek, Mistral, Together |

## Isolation

This is the part most tools are vague about, so here it is plainly.

### How a provider gets picked

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/png/03-provider-ladder.dark.png">
  <img alt="Providers probed in priority order: docker 20, podman 18, ssh 16, fly 14, then local 10 as the floor" src="docs/diagrams/png/03-provider-ladder.light.png">
</picture>

`auto` walks the ladder and takes the highest rung available. Every rung is free except `fly`, which is metered. An explicit `--provider` that is unavailable is an error — never a silent downgrade to something with weaker isolation.

### What each one actually gives you

| Provider | Isolation | Cost | Notes |
| --- | --- | --- | --- |
| `docker` | Kernel namespaces, cgroups, seccomp, read-only root | Free | Default when daemon is up |
| `podman` | Kernel, rootless | Free | Linux without Docker |
| `local` (WSL2) | **Guardrails only** | Free | Real Linux via private mount namespace |
| `local` (POSIX) | **Guardrails only** | Free | Your shell, jailed to a workspace |
| `ssh` | Whatever the remote provides | Free if you own it | Oracle Free Tier, a Pi, a VPS |
| `fly` | microVM | Metered | Bursty parallel work |

> **The `local` provider is not a sandbox.** It stops accidents, not adversaries. `husk doctor` reports `isolated: false` for it. See [SECURITY.md](SECURITY.md) for the full model.

### What crosses which line

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/png/05-trust-boundaries.dark.png">
  <img alt="A tool call passes the path jail, command policy and env scrub into the computer; results pass redact() and the audit log" src="docs/diagrams/png/05-trust-boundaries.light.png">
</picture>

These hold in **every** mode including `local`: path jail, command deny list, environment scrub, output caps, process-tree kill, `redact()` on every result, `audited()` on every MCP call. What `local` does *not* give you is a kernel boundary — it shares your kernel, your network and your user account.

`169.254.169.254` is blocked even in `network.mode: full`, because `full` means the internet, not the cloud metadata service that hands IAM credentials to anything that asks.

<sub>[Open interactively](docs/diagrams/05-trust-boundaries.html) · [SVG](docs/diagrams/svg/05-trust-boundaries.light.svg)</sub>

## Install

```bash
npm i -g @husk-ai/cli      # or: npx @husk-ai/cli
```

Node 20.10+. No native modules. Docker optional. API key optional.

## Packages

```
packages/
  core         contracts, husk.yaml schema, primitives
  runtime      computer providers: docker, podman, local, ssh, fly
  models       one surface over ten model providers
  sessions     transcript importers + the distiller
  browser      Chromium lifecycle and CDP automation
  agent        tool-calling loop and built-in tools
  adapters     Discord, Slack, Telegram, webhook
  mcp          MCP server (stdio + streamable HTTP)
  server       control-plane API + bot host
  sdk          typed client for the control plane
  cli          the husk command
apps/
  console      dashboard: live terminal, files, browser
  docs         documentation site (Next.js + MDX)
  web          marketing site (Next.js + Three.js)
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/png/02-system-architecture.dark.png">
  <img alt="The husk monorepo: four entry points over an orchestration layer over runtime, models, browser and sessions, all on @husk-ai/core" src="docs/diagrams/png/02-system-architecture.light.png">
</picture>

Dependencies run downhill. All ten packages import `@husk-ai/core`; core imports nothing from the workspace; nothing imports `@husk-ai/cli`. The dashed edges are dynamic imports rather than package dependencies — `cli → server`, `cli → mcp`, `server → agent` — so the server starts without the agent built.

<sub>[Open interactively](docs/diagrams/02-system-architecture.html) · [SVG](docs/diagrams/svg/02-system-architecture.light.svg)</sub>

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — why it is shaped this way
- **[API reference](docs/API.md)** — the control-plane HTTP contract
- **[Build contract](docs/BUILD-CONTRACT.md)** — conventions every package obeys
- **[Security model](docs/SECURITY-MODEL.md)** — what is isolated and what is not
- **[Examples](examples/)** — six ready-to-run `husk.yaml` recipes
- **[Diagrams](docs/diagrams/)** — 16 interactive architecture, dataflow and design diagrams

## Development

```bash
git clone https://github.com/Hotragn/husk.git && cd husk
npm install
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions, test philosophy, and how to add a provider or model.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR — it covers the build contract, test requirements, and the values that show up in code review.

## License

[Apache-2.0](LICENSE)
