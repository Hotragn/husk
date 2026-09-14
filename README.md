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

> [!WARNING]
> Husk is in **alpha** — the API, CLI flags, and `husk.yaml` schema may change between minor versions until v1.0. Pin your dependency versions and check the [changelog](CHANGELOG.md) before upgrading.

> **See how it fits together** — open the [interactive architecture diagram](docs/diagrams/01-hero.html) locally. Pan, zoom, dark/light mode, PNG/SVG export, no server needed.

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

> **[How the distiller works](docs/diagrams/04-chat-to-bot.html)** — interactive sequence diagram.

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

| Provider | Isolation | Cost | Notes |
| --- | --- | --- | --- |
| `docker` | Kernel namespaces, cgroups, seccomp, read-only root | Free | Default when daemon is up |
| `podman` | Kernel, rootless | Free | Linux without Docker |
| `local` (WSL2) | **Guardrails only** | Free | Real Linux via private mount namespace |
| `local` (POSIX) | **Guardrails only** | Free | Your shell, jailed to a workspace |
| `ssh` | Whatever the remote provides | Free if you own it | Oracle Free Tier, a Pi, a VPS |
| `fly` | microVM | Metered | Bursty parallel work |

> **The `local` provider is not a sandbox.** It stops accidents, not adversaries. `husk doctor` reports `isolated: false` for it. See [SECURITY.md](SECURITY.md) for the full model.
>
> **[Trust-boundary diagram](docs/diagrams/05-trust-boundaries.html)** — interactive view of what is isolated and what is not.

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

> **[Full system architecture](docs/diagrams/02-system-architecture.html)** — interactive diagram showing how every package connects.

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
