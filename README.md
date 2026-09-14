<div align="center">
  <img src="brand/logo/lockup-horizontal.svg" alt="Husk" height="72">
  <p><strong>Give your agent a computer.</strong></p>

  [![CI](https://github.com/Hotragn/husk/actions/workflows/ci.yml/badge.svg)](https://github.com/Hotragn/husk/actions/workflows/ci.yml)
  [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
  [![GitHub stars](https://img.shields.io/github/stars/Hotragn/husk)](https://github.com/Hotragn/husk)
</div>

---

Husk does two things.

**It gives any AI agent a disposable Linux machine** — a shell, a filesystem, ports —
that it can drive and you can throw away.

**It turns an AI chat into a bot.** Point it at a Claude Code, ChatGPT or Cursor
transcript and it distills that conversation into a `husk.yaml` you can read, edit, and
run as a service.

It is free, it runs on your own hardware, and it works without an account.

## Sixty seconds

```bash
npx @husk/cli doctor
```

That prints the honest state of your machine: which providers are usable, whether they
give you real isolation, and which models you can reach. Then:

```bash
npx @husk/cli up dev            # a Linux machine
npx @husk/cli exec dev -- 'uname -sr; python3 -V'
npx @husk/cli rm dev
```

No Docker? It still works — see [Isolation](#isolation-what-you-actually-get) for exactly
what you get and what you do not.

This is a real session on a Windows laptop with **no Docker daemon and no API key**:

```
$ husk up demo --provider local
✓ demo is up

  id         cmp_348ef7h8be2d
  provider   local  (WSL2 (Ubuntu))
  isolation  guardrails only — not a sandbox
  workdir    /work
  network    egress

$ husk exec demo -- 'uname -sr; echo hello > /work/note.txt; cat /work/note.txt'
Linux 6.18.33.2-microsoft-standard-WSL2
hello

$ husk exec demo -- 'sudo rm -rf /'
error refused: privilege escalation
hint:  add a pattern to guardrails.allowCommands in husk.yaml if this is intentional
```

A real Linux kernel and a real `/work`, on Windows, with nothing installed.

And the whole loop — agent, computer, model — for zero dollars, against a local
model on the same laptop:

```
$ husk run husk.yaml "Create /work/hi.txt containing the word banana, then tell me what it contains."

  husk       filecheck
  model      ollama/qwen2.5:7b
  computer   created on first use

── step 1
→ shell echo banana > /work/hi.txt; cat /work/hi.txt
computer ready: cmp_v2qw1mm65xtm (local)
banana
✓ 6.8s  exit 0

── step 2
The file /work/hi.txt contains the word banana.

2 steps · 956 tokens · free
```

## Give Claude Code a computer

```bash
claude mcp add husk -- npx -y @husk/mcp
```

That is the entire setup. Claude Code now has `shell`, `read_file`, `write_file`,
`list_dir` and `expose_port` against a real Linux machine, sandboxed away from your repo,
with the same filesystem persisting across the conversation. The same server speaks
streamable HTTP for Cursor, Zed, or anything else that talks MCP.

## Turn a chat into a bot

```bash
husk import                      # finds your Claude Code / ChatGPT transcripts
husk distill 3 --out triage.yaml # chat -> agent spec
husk run triage.yaml "check the build"
husk serve                       # now it is an HTTP endpoint, a Discord bot, a cron job
```

`husk distill` works with no API key at all — the heuristic distiller mines the
transcript for the instructions you kept repeating, the examples you did *not* correct,
and the tools you actually used. With a model available it does the same job better.

What comes out is a file you can read:

```yaml
name: triage
model: sonnet
fallbackModels: [gemma, llama]
persona: |
  You triage CI failures for a TypeScript monorepo.
  Always read the failing job log before guessing.
  Never rerun a job more than once.
tools: [computer, files]
computer:
  flavor: node
  network: { mode: egress, allow: ['*.github.com'] }
limits: { maxSteps: 24, maxCostUsd: 0.25 }
triggers:
  - { type: http }
  - { type: cron, schedule: '*/15 * * * *', prompt: 'any red builds?' }
```

## Models

Bring whatever you have. Aliases resolve across providers, so the same husk runs on Opus
or on a local Gemma by changing one word.

| | |
| --- | --- |
| **Free, local** | Ollama (`gemma`, `llama`, `qwen`), LM Studio |
| **Free tier** | Groq, Google AI Studio, OpenRouter `:free` models, Cerebras |
| **Paid** | Anthropic (`opus`, `sonnet`, `haiku`), OpenAI, Google, DeepSeek, Mistral, Together |

With nothing configured, `husk doctor` tells you the cheapest way to get to a working
model rather than failing with a missing-key error.

## Isolation: what you actually get

This is the part most tools are vague about, so here it is plainly.

| provider | isolation | cost | notes |
| --- | --- | --- | --- |
| `docker` | kernel — namespaces, cgroups, seccomp, dropped caps, read-only root | free | the default when the daemon is up |
| `podman` | kernel, rootless | free | Linux without Docker |
| `local` (WSL2) | **guardrails only** | free | real Linux, real `/work` via a private mount namespace |
| `local` (POSIX) | **guardrails only** | free | your shell, jailed to a workspace |
| `ssh` | whatever the remote is | free if you own the box | an Oracle Always Free ARM instance, a Pi, a VPS |
| `fly` | microVM | metered | bursty parallel work |

The `local` provider pins the working directory, resolves every path through `realpath`
and refuses escapes, strips credential-shaped environment variables, caps output, kills
the process tree on timeout, and refuses a short list of unrecoverable commands. **That
stops accidents. It will not stop an adversary**, and a prompt-injected model is closer
to an adversary than to an accident. `husk doctor` reports `isolated: false` for it, and
the CLI says so the first time you use it.

## No telemetry

Not "off by default" — absent. There is no analytics code, no crash reporter, no
phone-home. The only network calls Husk makes are to the model provider you configured
and to a registry when you pull an image.

## Install

```bash
npm i -g @husk/cli      # or npx @husk/cli
```

Node 20.10+. No native modules, so `npm install` is clean on Windows without a C++
toolchain. Docker is optional. An API key is optional.

## Repository

```
packages/
  core       contracts, husk.yaml schema, primitives
  runtime    computer providers: docker, podman, local, ssh, fly
  models     one surface over ten model providers
  sessions   transcript importers + the distiller
  agent      the tool-calling loop and built-in tools
  mcp        MCP server (stdio + streamable HTTP)
  server     control plane + bot host
  adapters   discord, slack, telegram, webhook
  sdk        typed client
  cli        the husk binary
apps/
  web        marketing site + docs
  console    dashboard: live terminal, files, playground
sandbox/     the container images
brand/       brand kit
```

- [Architecture](docs/ARCHITECTURE.md) — why it is shaped this way
- [API](docs/API.md) — the control-plane contract
- [Build contract](docs/BUILD-CONTRACT.md) — conventions every package obeys

## Development

```bash
npm install
npm run build:packages
npm test
node packages/cli/dist/bin.js doctor
```

## Licence

Apache-2.0.
