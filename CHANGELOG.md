# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file records what changed for people who installed the packages. Repository
housekeeping — CI, workflows, README edits, branch cleanup — lives in the commit log,
not here.

## [Unreleased]

### Added

- **`husk onboard` — the guided setup that was missing.** Between `npm i -g @husk-ai/cli`
  and a working first command sat: read `doctor`, pick one of eleven model providers, go
  and find a key, export it, come back, work out which of twenty commands to run. Every
  step of that was documented and none of it was in front of you. `onboard` walks the
  same ground and then does the next thing each time — it names your provider and how
  isolated it actually is, creates a computer and destroys it in front of you so you have
  seen it work before configuring anything, names the cheapest route to a model if you
  have none, and prints the MCP line for your editor. Five steps, each skippable, safe to
  re-run.

  It never asks for an API key. Husk reads credentials from the environment and does not
  store them; an onboarding that offered to hold one would make that false on the very
  first run, so it prints the `export` line and re-probes. With no terminal it prints the
  whole path as text and creates nothing, because a CLI that blocks for input inside a
  Dockerfile is a CLI people stop installing.
- **The one-time orientation now reaches every entry point.** It was wired to `husk up`
  alone, so anyone whose first command was `husk mcp` — a model about to be handed a
  shell — was never told what the isolation boundary was. `run`, `serve` and `mcp` say it
  too now, on stderr, so the MCP protocol channel stays clean.

### Fixed

- **`/work` did not name the same file for the shell as it did for the file tools.**
  Husk tells an agent that `/work` is its workspace. On the `local` provider the file
  tools honoured that and the posix shell did not, so `write_file('/work/scrape.py')`
  followed by `python3 /work/scrape.py` returned file-not-found — "write a script, then
  run it", on the provider you get by default when there is no Docker. The shell now
  maps guest-absolute paths onto the workspace it is already running in: quote-aware,
  lexical, trailing slashes preserved so `/work/$f` still concatenates, and lookalikes
  like `/workshop` left alone rather than helpfully repointed at a host file. Heredoc
  bodies are copied through untouched, because `cat > /work/notes.md <<EOF` is how an
  agent writes a file and the thing it writes about is usually the workspace. On WSL2
  the shell gets a real `/work` instead, bind-mounted per exec inside `unshare -mr`.
  A conformance suite now writes a file through the runtime, MCP, HTTP and shell
  surfaces and reads it back through every other one, against both `local` and
  `docker`, so the next surface to invent its own path space fails in CI.
- **The safety language called `/work` jailed when only half of it was.** That was true
  of the file tools and false of the shell, in four documents and in the MCP note a
  model reads before its first tool call — and a model that believes its shell is
  contained takes risks it otherwise would not. The docs now say which half is
  confined. The same correction reaches the trust-boundary diagram and the README for
  0.1.4: the path jail is a `local` control, not something every provider enforces. On
  `docker`, `podman` and `fly` the container is the boundary, so `read_file
  /etc/passwd` returns the container's own copy.
- **A run that could not fit the model's context was truncated into nonsense instead of
  refused.** Local servers still default to tiny contexts — llama.cpp long shipped
  `n_ctx 512` — and Husk's own system prompt plus the computer tool schemas is about
  2.5k tokens before the conversation starts. The run is now rejected before the first
  call, naming the tokens needed, the tokens available and the setting to raise.
- **A Chromium launch that never opened its debugging port leaked a browser per
  attempt.** The wait is bounded and the process is reaped, so a machine that cannot
  start a browser says so instead of accumulating one. The error quotes the real
  ceiling too: it said "within 40 seconds", which is the poll's arithmetic while every
  connect is refused instantly, not the 90 seconds a wedged listener can actually
  take.
- **`husk import` offered ordinary repository Markdown as chat transcripts.** Run from a
  project root it listed eighteen candidates, `CHANGELOG.md` among them, which made
  discovery useless in the first place most people try it. Markdown is content-sniffed
  now and has to look like a conversation.
- **A secret in a transcript title survived into the name derived from it.** Distilling
  a chat that mentioned an API key produced the slug `use-key-sk-antredacted` — the
  body was redacted and the prefix was not, which is a smaller leak rather than no
  leak. Redaction runs before anything becomes a name, a slug or a filename.
- **The distiller reported "configured without tools" while the spec it had just
  written listed them.** Prose and structured output are checked against each other.
- **An MCP computer that had been stopped could look connected while every command
  failed.** The next call resumes it where it can and reports the failure clearly where
  it cannot, and a failed readiness probe no longer returns a healthy-looking header.
- **`husk exec` turned a cmd.exe quoting mistake into somebody else's error message.**
  The documented `husk exec dev -- 'uname -sr && python3 -V'` is a posix-shell form;
  `cmd.exe` does not strip single quotes, so Husk received `'uname` and the container
  runtime failed with `exec: "'uname": executable file not found in $PATH`. Husk now
  recognises the stray quote before it resolves a provider and prints the double-quoted
  form of what you meant.

- **On Windows without a working WSL, `husk doctor` said nothing useful and sometimes
  contradicted itself.** The warning written for that case was gated on a test that no
  reachable state could pass, so it had never printed. The `local` provider reported
  "with no WSL" even when WSL was installed and simply not responding, directly beneath
  a line saying the opposite, and told people to `wsl --install` something they already
  had. The fix that would have helped was never shown at all, because hints only
  printed for providers reported as unavailable and `local` is always available.
  `doctor` now distinguishes the two states, gives each its own fix, and says that
  Docker is down for the same reason — its engine runs inside WSL2.
- **A model given a degraded Windows computer was told it had Linux.** The first tool
  result said the machine was "on the Windows shell", which is a label with no
  consequence attached; the model would still open with `ls -la /work` and then retry
  variations of a command that could not work. It now says what actually differs —
  `$VAR` does not expand and `'single quotes'` are not quotes, both silently at exit 0
  — and that Unix tools may or may not be on `PATH` depending on what else is
  installed. A command that fails because the shell is `cmd.exe` now carries that
  reason with it, rather than only at the top of the session.

## [0.1.3] - 2026-09-16

The browser works on Docker again, and husk stops naming things it does not own.

### Fixed

- **`flavor: full` never had a working browser on `docker` or `podman`.** The image it
  actually landed on was `debian:bookworm`, which ships no Chromium, so the `browser_*`
  tools on a `full` computer had nothing to drive. It resolves to
  `mcr.microsoft.com/playwright:v1.59.1-noble` now.
- **Every flavour tried `ghcr.io/husk-sh/husk-<flavor>` first** — a namespace husk does
  not own and has never pushed to — so the first pull on every fresh install was a
  guaranteed 404. It recovered quietly by substituting the public base image, which
  meant you ran something other than the image your spec named and lost the `huskinfo`
  script with it. Flavours resolve to a public image outright now, and `HUSK_REGISTRY`
  turns the old two-step back on as an opt-in mirror.
- **`husk --version` reported `0.1.0` while you were running 0.1.1.** Four constants
  carried the version by hand and none were bumped with the manifests, so the CLI,
  `husk doctor`, `/health`, `/v1/doctor`, the `X-Husk-Version` header and both outbound
  User-Agent strings all named a release nobody was on.
- The install instructions named `@husk/mcp`. Nothing is published under that scope and
  the scope is not ours, so the command 404'd for everyone who copied it. The published
  name is `@husk-ai/mcp`.
- `computer_info` did not answer the question its own description tells a model to call
  it for, so a model asking what was installed had to fall back to probing with shell
  commands.

### Security

- **Removed every reference to `husk.sh` and the `husk-sh` GitHub organisation.**
  Neither is ours, and both shipped to npm in 0.1.0, 0.1.1 and 0.1.2. The OpenRouter
  attribution header sent `http-referer: https://husk.sh`, and four User-Agent strings
  advertised the same domain to every model provider and every page the browser
  fetched.

## [0.1.2] - 2026-09-16

### Fixed

- **`husk` exited 0 and printed nothing when installed from npm.** The published `bin`
  pointed at a wrapper whose entry-point guard never matched through npm's shim, so the
  command that is the product's entire surface did nothing at all — silently, and with a
  success exit code, on every install of 0.1.1.
- `@husk-ai/mcp` documented a streamable HTTP transport it does not implement. The
  server speaks stdio, and the docs now say only that.
- The `@husk-ai/sdk` readme linked with `../..`, which npm cannot follow, so every
  relative link on its package page was broken.

### Added

- Webhook signature verification tests, covering the replay-window boundary at exactly
  the tolerance and the empty-body case ([#26](https://github.com/Hotragn/husk/pull/26),
  thanks [@EthemKD](https://github.com/EthemKD))
- `engines: { node: ">=20.10" }` on all eleven packages, so npm refuses an unsupported
  Node instead of failing at runtime. `repository`, `homepage` and `bugs` are now
  declared too, which is what makes the npm page link back here.

### Security

- The security disclosure address was `security@husk.sh`, a mailbox at a domain we do
  not control, printed in `SECURITY.md` as the place to send vulnerability reports.
  Disclosures now go through
  [GitHub private vulnerability reporting](https://github.com/Hotragn/husk/security/advisories/new),
  which is the only channel that is monitored.

## [0.1.1] - 2026-09-14

The first version published to npm.

### Changed

- **The npm scope is `@husk-ai/`, not `@husk/`** — `@husk` was already taken on the
  registry. Install commands and import specifiers change. The CLI binary is still
  `husk`, and `husk.yaml` is unchanged.

### Fixed

- Inter-package dependencies still pinned `0.1.0` after the packages themselves were
  bumped to `0.1.1`, so npm could not resolve them locally and fell through to the
  registry, where they did not exist. Installing anything with a sibling dependency —
  `@husk-ai/agent`, `@husk-ai/cli`, `@husk-ai/sdk` — failed.

## [0.1.0] - 2026-09-14

The first version that does the two things on the tin.

### Added

**A computer for agents**

- Five providers behind one `Computer` interface: `docker`, `podman`, `ssh`, `fly`,
  and `local`. `auto` walks them in that order, preferring real isolation over
  guardrails and free over metered, with `local` as the floor that is always there.
- **Real Linux on Windows without Docker.** The `local` provider runs each command
  inside a WSL2 user + mount namespace (`unshare -mr`) that bind-mounts the workspace
  onto `/work`. The agent is uid 0 inside the namespace, files land owned by the real
  user outside it, and the mount disappears when the command exits — so two computers
  never see each other. Falls back to the host shell, loudly, when WSL is absent.
- `ComputerManager.ensure(key)` maps a stable key to a machine, so one conversation
  keeps one filesystem without the caller tracking ids. Concurrent callers share a
  single in-flight create rather than racing into two machines.
- Snapshots commit the image *and* tar the workdir, because `/work` is a tmpfs and a
  commit alone would silently lose everything the agent did.

**A chat becomes a bot**

- Importers for Claude Code JSONL, ChatGPT exports, Cursor, Gemini and pasted
  markdown. Branched threads are reconstructed by walking `parentUuid` from the last
  leaf, so you get the conversation as it actually ran.
- Two distillers. The model-backed one map/reduces over the whole transcript; the
  heuristic one needs no key, no network, and reports an honest confidence with a list
  of what it could not determine.
- `husk.yaml` is the unit of value: readable, diffable, and validated by a zod schema.

**Models**

- Eleven providers, no vendor SDKs — the wire-format translation is the package.
  Anthropic, OpenAI, Google, Groq, OpenRouter, Together, DeepSeek, Mistral, Cerebras,
  Ollama, LM Studio.
- Aliases (`opus`, `sonnet`, `gemma`, `free`, `auto`) keep a spec portable.
- Fallback emits a `warning` event. Silently answering with a weaker model than the one
  requested is worse than failing.

**MCP**

- `claude mcp add husk -- npx -y @husk-ai/mcp` gives Claude Code a computer
  mid-conversation. Seven tools over stdio, and the first tool result states plainly
  that a `local` computer is not a sandbox.

### Security

- Path jail with symlink resolution, environment scrubbing, output caps, process-tree
  kill on timeout, and a command deny list anchored to command position — so
  `grep -r "sudo" .` is not refused, because a deny list that cries wolf gets disabled.
- **The network floor refuses loopback, link-local and RFC1918 even in
  `network.mode: 'full'`.** `full` means the internet, not the cloud metadata endpoint
  at `169.254.169.254` that hands IAM credentials to anything that asks.
- `ask`-mode approval fails closed: no approver wired means the call is denied.
- Budgets — step, cost, token, wall clock — are checked *before* a model call, so a
  ceiling is never breached, only prevented.
- `isolationKind` distinguishes `kernel`, `machine` and `guardrails`. A boolean
  overclaimed for `ssh`, which is isolated from your laptop but not from the box it
  runs on; `husk doctor` now says "isolated from this machine".

### Known gaps

Not a Keep a Changelog section, but shipping a list of what does not work belongs next
to the list of what does.

- The hosted control plane does not exist. `husk serve` is a single-user local daemon.
- `web_search` needs a Brave or Tavily key; without one the tool is not registered
  rather than failing at call time.
- Anthropic's Opus and Sonnet cache-write prices are derived from estimated input
  rates and are marked `estimatedPricing`.

[Unreleased]: https://github.com/Hotragn/husk/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/Hotragn/husk/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Hotragn/husk/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Hotragn/husk/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Hotragn/husk/releases/tag/v0.1.0
