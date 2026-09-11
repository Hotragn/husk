# Husk — brand

The rest of this directory is downstream of this file. If a colour, a headline, or a
button state contradicts something written here, this file wins.

---

## 1. Positioning

### Category

**A local-first computer for AI agents.**

Not a sandbox platform. Not an agent framework. Not an AI company. Husk is a runtime that
turns hardware you already own into something an agent can drive, and turns a chat you
already had into something that keeps running.

### Positioning statement

> For backend and AI engineers who need an agent to actually touch a machine, **Husk** is
> a local-first runtime that hands any agent a disposable Linux computer and turns any AI
> chat transcript into a running bot. Unlike hosted sandbox platforms, Husk needs no
> account, no card, and no network — the free path on your own hardware is the default
> path, not a trial.

### The one-line promise

> **The free path always works.**

Everything else is a feature. This is the commitment. No feature ships that makes the
no-account, no-key, no-Docker path worse. If the free path degrades, it degrades
loudly and with a hint, and it does not hard-fail.

### Tagline

> **Empty by design.**

Read it three ways, all true: a husk is empty; a fresh machine has nothing installed and
no opinions; and there is no account, no profile, no telemetry — nothing of yours is held
anywhere.

### 25 words

> Husk gives any AI agent a disposable Linux computer, and turns any chat into a bot.
> Runs free on your machine. No account, no telemetry.

### 100 words

> Husk gives any AI agent a computer. Run `claude mcp add husk -- npx -y @husk/mcp` and
> your assistant has a Linux machine mid-conversation: shell, filesystem, ports,
> snapshots. Docker when it is there, Podman when it is not, and a guarded local
> workspace when neither is — we tell you which one you got, and whether it is really
> isolated. Point Husk at a Claude Code or ChatGPT transcript and it distills the
> conversation into a `husk.yaml` you can read and edit, then serves it as a bot over
> HTTP, Discord, Slack, cron, or the CLI. No account. No telemetry. Apache-2.0.

---

## 2. The name

A husk is the dry outer shell a living thing grows inside: the papery leaves around an ear
of corn, the hull around a seed. It is the part that is left when the living thing leaves.
People use "husk" to mean *empty* — and that is the point.

Three reasons the name is load-bearing rather than decorative:

1. **Shell is the literal deliverable.** A husk is a shell. What we hand an agent is a
   shell. The pun is not clever; it is a description.
2. **The emptiness is the value proposition.** We supply the body; the agent supplies the
   mind. Husk has no opinions about what the agent does, no built-in prompt, no
   personality, no model preference it will not let you override. A competitor that
   named itself for intelligence would have to keep proving it. We only have to stay
   empty.
3. **It survives being said out loud in a terminal.** One syllable, four letters, no
   ambiguous spelling, no vowel a non-native speaker will guess wrong, and `husk` was a
   plausible-looking binary name before it was a product. `husk run`, `husk ps`,
   `husk doctor` all read like tools that already existed.

**What we do not do with the name.** No corn imagery. No agriculture metaphors in body
copy ("plant your agent", "harvest your results" — never). No "husk of your former
workflow". The metaphor earns exactly one job: explaining the mark and the palette. After
that it gets out of the way.

**Casing.** `Husk` in prose, `husk` as the binary and in code, `@husk/*` for packages.
Never `HUSK`, never `HuSK`, never `husk.` with a trailing period in the wordmark.

---

## 3. Personality

Five adjectives. Each one is paired with the thing it is most often mistaken for, because
the counterpart is what actually keeps copy on-brand.

| We are | We are **not** | The difference in practice |
| --- | --- | --- |
| **Plainspoken** | Folksy | Plainspoken is "Docker is not running. Husk used the local provider instead." Folksy is "Whoops — looks like Docker took the day off!" Short declaratives, no winking. |
| **Exact** | Pedantic | Exact is "probes are cached for 30 seconds." Pedantic is a footnote explaining why 30 and not 25. Give the number, skip the defence. |
| **Candid** | Confessional | Candid is "`local` is guardrails, not a sandbox." Confessional is three paragraphs of anxiety about threat models on the landing page. State the limit once, in the place the user is about to hit it, then move on. |
| **Dry** | Snarky | Dry is "No telemetry. Not off by default — absent." Snarky is "Unlike *some* products, we don't spy on you." Humour comes from precision, never from a target. |
| **Generous** | Ingratiating | Generous is shipping the full product for free and not mentioning it again. Ingratiating is a banner that says "100% FREE FOREVER 🎉". If the generosity needs a badge, it is not generosity, it is a funnel. |

---

## 4. Voice and tone

### The seven rules

**1. Lead with the mechanism, not the benefit.**
Our audience installs things with a package manager and has been lied to by a landing page
this month. Describe what happens; let them infer that it is good.

> ✗ *Effortlessly give your AI the power to run code in a secure, isolated environment.*
> ✓ *`husk mcp` hands Claude Code a Linux container over stdio. Shell, files, ports.*

**2. Name the provider, always.**
"Sandbox", "isolated", and "secure" are meaningless without the provider attached. Husk
runs on five, and two of them are not isolated in any meaningful sense.

> ✗ *Your agent runs safely in a sandbox.*
> ✓ *On Docker and Podman you get kernel isolation. On the `local` provider you get
> process guardrails — a pinned working directory, path-escape rejection, scrubbed
> credentials, a deny list. That stops accidents. It does not stop an adversary, and a
> prompt-injected model is closer to an adversary than to an accident.*

**3. One command beats one paragraph.**
If a shell line can carry the claim, ship the shell line and cut the paragraph.

> ✗ *Getting started is easy. Simply install the Husk MCP server, add it to your Claude
> Code configuration, and you'll be up and running in minutes.*
> ✓ ```bash
> claude mcp add husk -- npx -y @husk/mcp
> ```
> *That is the whole install. There is no second step.*

**4. Numbers instead of adjectives.**
"Fast" is a claim. "~800 ms on a cold Docker daemon, which is why probes are cached for
30 s" is a fact that happens to make the same point.

> ✗ *Blazing-fast startup and rock-solid reliability.*
> ✓ *A cold `docker version` takes about 800 ms, so provider probes are cached for 30
> seconds — an agent that creates four machines in a row pays that cost once.*

**5. Every error says what to do next.**
This is a build-contract rule (`HuskError` carries a `code` and a one-line `hint`), and it
is a voice rule too. A sentence that describes a failure without a next action is not
finished.

> ✗ *Error: no model provider configured.*
> ✓ *No model provider configured. Husk can run computers but not agents.
> Fix: `ollama pull gemma3` for a free local model, or set `ANTHROPIC_API_KEY`.*

**6. Second person, present tense, active voice.**
"Husk writes the file" or "you get a machine". Never "a machine is provisioned".

> ✗ *Transcripts are parsed and an agent definition is generated.*
> ✓ *Husk reads the transcript, walks `parentUuid` back from the last leaf to get the
> conversation as it actually ran, and writes a `husk.yaml` you can diff.*

**7. Sentence case everywhere. No exclamation marks. No em-dash pile-ups.**
Headings, buttons, nav, docs titles: sentence case. The only capitalised words are proper
nouns and code. Exclamation marks appear zero times in shipped copy, including in
success states. One em dash per paragraph, maximum.

### Tone by surface

| Surface | Tone | Notes |
| --- | --- | --- |
| **CLI output** | Terse, factual, aligned | The terminal is not a place for personality. Fixed-width columns, no colour without a fallback, no spinner longer than the work. |
| **Errors** | Direct, then actionable | Two lines: what happened, what to do. Never apologise. Never say "unexpected". |
| **Docs** | Patient, mechanical | Assume competence, not context. Explain the *why* once, then get out of the way. |
| **README** | Confident, dense | The first screen must contain a runnable command and the honest caveat. |
| **Landing page** | Restrained, specific | The hero can be bold. Nothing below it may overclaim. |
| **Launch posts** | Conversational, unpromotional | Written by a person who built a thing, not by a company announcing a thing. |
| **Release notes** | Boring on purpose | Verb, object, consequence. Breaking changes first, in bold. |

### Vocabulary

| Use | Instead of |
| --- | --- |
| computer | sandbox, environment, VM, box (unqualified) |
| guarded | safe, secure, protected |
| isolated (with a named provider) | isolated (bare) |
| spin up / start | provision, orchestrate, deploy |
| husk / `husk.yaml` | agent config, persona file, prompt template |
| distill | summarise, generate, extract |
| free | freemium, free tier, community edition |
| local | on-prem, self-hosted, air-gapped |
| model provider | LLM, the AI |

---

## 5. Three things we never say

**1. "Sandbox", "secure", or "isolated" without a provider attached.**
*Why it is banned:* Husk's `local` provider gives process guardrails, not containment.
Two of five providers are not isolated. An unqualified isolation claim is the exact lie
that ends up in someone's incident report, and `Availability.isolated` exists on the
provider interface specifically so we never have to make it. If a sentence needs the word
"secure" to work, the sentence is wrong.
*Say instead:* "kernel isolation on Docker and Podman; process guardrails on `local` —
`husk doctor` tells you which one you have."

**2. "It just works" / "magic" / "effortless" / "zero config".**
*Why it is banned:* Our audience reads these as a warning that something is being hidden
from them, and they are usually right. Husk has real failure modes — no Docker daemon, no
API key, a 429 from Anthropic, a Windows box with no WSL — and the product's actual
selling point is that it tells you about them clearly. Claiming magic throws away the
thing we are good at.
*Say instead:* the command, then what it did, then what it fell back to and why.

**3. "Trusted by", "loved by developers", "join N,000 engineers", or any logo wall.**
*Why it is banned:* Husk has no telemetry, so we could not count users honestly even if we
wanted to — and a social-proof claim we cannot reproduce is a claim we are not allowed to
make. It also inverts the trust model: this product is meant to be verified in one
command on the reader's own laptop, not believed because someone else believed it.
*Say instead:* a command the reader can run in ten seconds, or nothing.

Adjacent, also banned: "revolutionary", "game-changing", "unleash", "supercharge",
"seamlessly", "enterprise-grade", "AI-powered" (we are the thing AI is powered *by*), and
any sentence that begins "In today's fast-moving world of AI".

---

## 6. The competitive frame

Husk's competitors are not who a positioning deck would guess. The real alternative for
most of our audience is *a terminal they already have open*. Everything below is written
to be true, checkable, and free of cheap shots — if a competitor is better at something,
we say so, because our audience will find out in ten minutes anyway.

| | What it is | Where it wins | Where Husk wins |
| --- | --- | --- | --- |
| **E2B** | Hosted, SDK-first sandboxes purpose-built for AI agents. | Managed infrastructure, fast cold starts, a polished SDK, someone else's problem when it breaks. If you are building a product on top and billing your users, this is a real answer. | Requires an account and metered cloud compute. Husk starts on the laptop you already own with no signup, and the same `Computer` interface can point at Fly later without changing the husk. |
| **Daytona** | Hosted dev environments repositioned around agent sandboxes. | Very fast environment provisioning, good team/workspace story, IDE integrations. | Same shape of trade: hosted-first, account-first. Husk's primitive is local and its hosted providers are plugins behind one interface, not the other way around. |
| **Modal** | Serverless compute for AI/ML workloads. Python-native, GPU-capable. | Batch jobs, GPU inference, scale-out fan-out. Genuinely excellent at a job Husk does not do — we have an explicit non-goal on GPU orchestration. | Different weight class. Husk is a conversation's worth of computer, created lazily, reaped on idle. Nobody reaches for a serverless job runner to let Claude Code untar a file. |
| **Fly.io** | Machines API, real microVMs, global. | Raw infrastructure quality. Actually good enough that Husk uses it. | Not a competitor — a backend. `fly` is one of Husk's five providers. Fly hands you a machine; Husk hands your *agent* a machine, plus the lifecycle, redaction, budget ceilings, and MCP wiring you would otherwise write yourself. |
| **Docker (plain)** | The honest baseline: `docker run -it ubuntu bash` and paste things by hand. | Free, understood, already installed, zero new concepts. This is what most of our audience does today, and we should respect that. | Husk *is* Docker, on the default path — plus a stable key→machine mapping so a conversation keeps its filesystem, an idle reaper, output clamping, `redact()` before tool output re-enters the model, and one line of MCP config instead of you being the copy-paste layer. |

**The frame in one sentence:**
> Everyone else sells you compute. Husk wires up the computer you already have — and when
> you outgrow it, the same `husk.yaml` runs on someone else's.

**What we concede, on the record.** Husk is single-user in v1 with no hosted control
plane. It does not do GPUs. Cold starts on Docker are Docker's cold starts. The `local`
provider is not a security boundary. Saying these first is cheaper than being caught
omitting them.

---

## 7. Messaging pillars

Four pillars. Every piece of copy should be traceable to one of them, and each has a proof
that runs in a terminal.

### Pillar 1 — The free path is the product

*Claim:* No account, no card, no API key, no Docker required, and the thing still runs.
*Because:* The local provider is the primitive; hosted providers are plugins behind the
same interface. There is no code path that requires an account.
*Proof:* `npx -y @husk/cli doctor` on a bare machine prints a working configuration.
*Copy that lives here:* the hero, pricing (there is none), the README's first screen.

### Pillar 2 — Honest about containment

*Claim:* Husk tells you exactly how isolated you are, every time, before you need to know.
*Because:* `Availability.isolated` is on the provider interface, `husk doctor` prints it,
and the CLI warns on first use of `local`.
*Proof:* `husk doctor` names your provider, its isolation, and the reason.
*Copy that lives here:* the security page, the `local` provider docs, every mention of
sandboxing anywhere.

### Pillar 3 — Your chat is already an agent

*Claim:* The conversation you had yesterday is a bot you can run today.
*Because:* Importers normalise Claude Code JSONL, ChatGPT exports, Cursor, and markdown
into one `Transcript`; the distiller mines it into a `husk.yaml` and reports honest
confidence, including what it could not determine.
*Proof:* `husk import ~/.claude/projects/.../session.jsonl` → a `husk.yaml` you can read.
*Copy that lives here:* the second fold, the `sessions` docs, most of the launch post.

### Pillar 4 — Nothing leaves

*Claim:* Nothing leaves the machine except the calls to the model provider you configured.
*Because:* No telemetry, no analytics, no crash reporter — absent from the codebase, not
disabled by a flag. Tool output passes through `redact()` before it re-enters the
conversation.
*Proof:* grep the repo. Apache-2.0, and the network calls are the ones you can name.
*Copy that lives here:* the footer, the privacy page (one screen, no legalese), the
`redact()` docs.

### The supporting wedge, not a pillar

`claude mcp add husk -- npx -y @husk/mcp` is the single highest-value line of copy Husk
owns. It is not a pillar because it is not a value — it is the proof for Pillar 1, and it
should appear within the first screen of every surface where a command is legal.

---

## 8. Where the brand shows up

| Element | Rule |
| --- | --- |
| **Colour** | Warm, dry outer layer (`primary`, "husk gold") against a cold, electric inner core (`accent`, "core teal"). Gold is the shell — chrome, rules, marks, the frame. Teal is the live thing — links, focus, running state, cursors. Never gradient them into each other. |
| **Type** | Bricolage Grotesque for display (a grotesque with visible tool marks), Instrument Sans for UI, JetBrains Mono for anything a machine wrote. Mono is a semantic choice, not a decorative one: if the machine said it, it is monospaced. |
| **Mark** | A split husk with a lit core. Works in one colour at 16 px. See `logo/USAGE.md`. |
| **Motion** | Motion is reserved for state changes the user caused. Nothing on this brand ambient-animates. See `UI-PRINCIPLES.md`. |
| **Imagery** | Terminal output, real file trees, real `husk.yaml` files, real `husk doctor` reports. No abstract renders, no glowing orbs, no robots, no brains, no hands touching holograms. If we cannot screenshot it, we do not show it. |

---

*Owner: brand. Version 1.0. Every colour value in this kit has a measured contrast ratio
in `tokens.css`; every claim above has a command that proves it.*
