# Husk — voice examples

Copy written to the seven rules in `BRAND.md` section 4. Where a rule is doing
visible work, it is named in the margin notes.

The picks in section 1 are the homepage's hero, and section 4 is the README's
opening, as they ship. The rest show the voice and are not transcripts: the CLI
output and errors in sections 2 and 3 are not what the current CLI prints, and some
of the commands and flags in them do not exist.

---

## 1. Hero

### Headline — three options

**A. Your AI chat gets a computer.**
Six words a person can repeat without explaining. It names the thing the reader
already has open, an AI chat, and the one thing that changes. No category word and
no adjective doing the persuading.

**B. Give your agent a computer.**
The previous pick. Imperative, mechanism-first, and it survives being read in a
tweet with no context. But it asks the reader to know what an agent is, and to
see their chat as one, before the sentence lands.

**C. Empty by design.**
The old tagline promoted to headline. Memorable, ownable, and completely opaque
to someone who arrived from a link. Its meaning lives on in plain words under the
footer mark, not above the fold.

**Pick: A — "Your AI chat gets a computer."**

It is the tagline in `BRAND.md`, and the least abstract sentence available to
someone who arrived with a chat app open: it starts from what they already have.
B is the same promise addressed to someone who builds agents. C is a better
*footer*. A also leaves the honesty to the lines under it, which is the shape of
every trustworthy Husk sentence: the headline makes the promise, and the next
lines say what you get and where it stops.

### Subhead — three options

**A.** Add Husk to Claude Code, Codex or Cursor and your AI gets a machine of its
own: a terminal, files and a browser. It can run the code it writes, check the
pages it talks about, and keep what it finds in a workspace you can reopen
tomorrow.

**B.** A terminal, files and a browser it can actually use, and a workspace that
keeps what it finds for next time.

**C.** A disposable Linux machine your agent can drive: shell, filesystem,
ports. Docker when it is there, a guarded local workspace when it is not, and
`husk doctor` tells you which one you got. No account, no card, no telemetry.

**Pick: A.**

It names the apps the reader already uses, the three things they get, and what
each one is for. B is the same promise at README length, and the README uses it.
C was the pick when the page led with the computer alone; its caveat now sits in
the line under the lead, and in full in the providers section, where the reader
is asking how contained the computer is.

### The hero, assembled

> # Your AI chat gets a computer.
>
> Add Husk to Claude Code, Codex or Cursor and your AI gets a machine of its own:
> a terminal, files and a browser. It can run the code it writes, check the pages
> it talks about, and keep what it finds in a workspace you can reopen tomorrow.
>
> The 0.2.0 desktop preview starts with workspace tools. Computer access is
> opt-in after provider review.
>
> **Start in Claude Desktop** · **Set up computer tools**
>
> No Husk account, and no extra API key for workspace tasks. Open source under
> Apache-2.0. Your AI app’s own usage limits still apply.

Two buttons, no third. No "trusted by". No logo wall. The proof sits directly
under it: a replay of a real run on a laptop with no Docker and no API key,
which ends on a command Husk refused.

---

## 2. First-run CLI output

`husk` with no arguments, on a machine that has never run it. This is the most
important 20 lines of copy in the product: it is where the free path either
proves itself or does not.

Illustrative: this is the first run the copy is written for. Today `husk` with no
arguments prints its help, and `husk onboard` is the guided first run.

```
$ husk

husk 0.2.0 · first run · ~/.husk created

computer providers
  docker      unavailable   installed, but the daemon is not reachable
  podman      not found
  local       ready         guarded working directory
                            ~/.husk/workspaces -- process guardrails, not a sandbox

model providers
  ollama      ready         gemma3, qwen2.5-coder
  anthropic   no key        set ANTHROPIC_API_KEY
  openai      no key        set OPENAI_API_KEY

selected      local + ollama/gemma3       free, on this machine, no account

  The local provider pins the working directory, rejects path escapes, scrubs
  credential-shaped environment variables and kills runaway process trees. That
  stops accidents. It is not a security boundary, and a prompt-injected model is
  closer to an adversary than to an accident. Start Docker for kernel isolation.

next
  husk run "list the files in this directory"    run an agent on that computer
  husk import <transcript>                       turn a chat into a husk.yaml
  claude mcp add husk -- npx -y @husk-ai/mcp        give Claude Code a computer
  husk doctor                                    this report, any time

no telemetry. nothing left this machine.
```

Notes on why it is shaped this way:

- **The bad news is in the same table as the good news**, in the same type, at
  the same weight. Docker being down is not an error state; it is a row.
- **Every unavailable thing carries its fix on the same line.** Rule 5.
- **The `local` caveat gets four lines and no bold, no icon, no colour.** It is
  important, so it is stated plainly. Making it shout would make it feel like a
  disclaimer, which is what people skip.
- **`selected` is one line and says "free".** That is the whole Pillar 1 payoff.
- **The last line is a fact, not a boast.** "no telemetry. nothing left this
  machine." Lowercase, full stop, no exclamation mark, no shield emoji.

---

## 3. Error messages

Every one is a `HuskError` with a `code` and a one-line `hint`. The format is:
what happened, then what to do. Never an apology, never "unexpected", never a
stack trace unless `--verbose`.

### E_PROVIDER_UNAVAILABLE

```
E_PROVIDER_UNAVAILABLE  docker is installed but the daemon is not reachable

  Husk can still run on the local provider, which is guarded but not isolated.

  fix   start Docker Desktop, then re-run
  or    husk run --provider local        accept guardrails for this run
  or    husk config set provider local   stop asking
```

> Three exits, ordered by how much the user probably wants them. The middle one
> is the honest downgrade and it names the trade-off in the line above rather
> than hiding it behind a flag description.

### E_BUDGET_EXCEEDED

```
E_BUDGET_EXCEEDED  run stopped at step 14 of 40: spent $0.42 of a $0.40 ceiling

  The computer cmp_7f3a is still up and still has your files. Nothing was lost.

  fix   husk run --resume run_9c21 --budget 2.00     continue with more headroom
  or    husk ps                                      inspect the machine first
  see   husk.yaml -> limits.costUsd                  raise the default
```

> The second line exists because the first thing a person feels when a run halts
> mid-way is "did I just lose the work". Answer that before offering the fix.
> The exact numbers are there so the ceiling does not feel arbitrary.

### E_PATH_DENIED

```
E_PATH_DENIED  the agent tried to write outside its workspace

  wanted   /home/me/.ssh/authorized_keys
  allowed  /home/me/.husk/workspaces/ws_4a1c

  The local provider resolves every path through realpath and rejects escapes.
  This one was rejected. The agent has been told, and the run is continuing.

  see   husk logs run_9c21 --tool files.write
  if this was legitimate, mount the path explicitly:
        husk run --mount /home/me/project:/work
```

> This is the message that decides whether the platform engineer trusts us. It
> shows both paths, names the mechanism (`realpath`), says what the system did,
> and says the run did not die. Then it offers the legitimate escape hatch,
> because sometimes the agent was right.

---

## 4. README opening paragraph

> **Your AI chat gets a computer.**
>
> A terminal, files and a browser it can actually use, and a workspace that keeps
> what it finds for next time.
>
> Husk gives your AI chat named local workspaces. Save public web sources, ask your
> AI for a cited brief, comparison, or action list, then review and download the
> result. Reopen the same workspace in your next chat. No Husk account, Docker,
> terminal, or additional model API key is needed for this starter flow.

> The headline, then the line that says what the chat gets, then the first task
> a beginner can finish. The developer's route, the computer tools, comes second,
> under its own heading.

---

## 5. Docs quickstart intro

> # Quickstart
>
> This takes about two minutes and needs Node 20.10 or newer. It does not need
> Docker, an API key, or an account — those all make Husk better and none of
> them make it work.
>
> You are going to do three things: check what your machine can actually do, run
> an agent on a computer, and wire that computer into Claude Code. If step one
> tells you something is missing, keep going anyway. Every capability in Husk
> degrades to something that still runs, and `husk doctor` will always tell you
> which version of the product you are currently using.
>
> One thing to read before you start: on the `local` provider, Husk gives you
> process guardrails, not containment. What that means, precisely, is in
> [Isolation](./isolation.md). It is worth four minutes if anything sensitive
> lives on this machine.

---

## 6. Launch post — first 100 words

> I got tired of being the clipboard.
>
> Every session with Claude Code went the same way: it would suggest a command,
> I would paste it into a terminal, paste the output back, and repeat. The model
> had the reasoning and I had the machine, and the two of us were connected by
> me pressing Cmd-V four hundred times a day.
>
> So I built Husk. One command gives Claude Code a real Linux machine — shell,
> files, ports — on hardware you already own:
>
> ```
> claude mcp add husk -- npx -y @husk-ai/mcp
> ```
>
> No account. No card. No telemetry.

> Written in first person by someone who built a thing, not in third person by a
> company announcing a thing. It opens on a specific, physical annoyance rather
> than a market claim, and the first sentence contains no nouns from the AI
> vocabulary. The command arrives before any feature list.

---

## 7. Lines to keep and lines to kill

Things that are on-voice and can be reused:

- "Docker when it is there, a guarded local workspace when it is not."
- "No telemetry. Not off by default — absent."
- "That stops accidents. It does not stop an adversary."
- "The free path is the same path everything else is built on."
- "`husk doctor` tells you which version of the product you are currently using."
- "We supply the body. The agent supplies the mind."

Things that will get written by accident and must be cut on sight:

- "Securely sandbox your AI agents" — banned word, and untrue for two of five
  providers.
- "Get started in seconds" — a time claim we cannot control on someone else's
  npm cache.
- "Husk makes it easy to..." — if it is easy, show the command; if it needs the
  word "easy", it is not.
- "Powered by AI" — Husk is what AI is powered by.
- "Join thousands of developers" — we have no telemetry, so we cannot count,
  so we cannot say it.
- "🚀" — no.
