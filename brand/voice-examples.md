# Husk — voice examples

Real copy, ready to ship. Every line here obeys the seven rules in `BRAND.md`
section 4. Where a rule is doing visible work, it is named in the margin notes.

---

## 1. Hero

### Headline — three options

**A. Give your agent a computer.**
Five words, imperative, mechanism-first. States the product literally, with no
adjective doing the persuading. Survives being read in a tweet with no context.

**B. Your agent needs a machine. You already own one.**
Two beats: the problem, then the reframe. Carries the free-and-local pitch in
the headline itself, which is Pillar 1. Longer, and the second sentence only
lands if the reader already knows agents need machines.

**C. Empty by design.**
The tagline promoted to headline. Memorable, ownable, and completely opaque to
someone who arrived from a link. It earns its place under the mark, not above
the fold.

**Pick: A — "Give your agent a computer."**

Because our audience bounces on abstraction and this is the least abstract
sentence available. It is a verb, an object, and nothing else. B is a better
*paragraph* opening and C is a better *footer*; both ask the reader to do a
small amount of interpretive work before they know what the page is for, and at
the top of a landing page that work does not get done. A also sets up the
subhead to carry the honesty — the headline makes the promise, the subhead
immediately qualifies it, which is the shape of every trustworthy Husk sentence.

### Subhead — three options

**A.** A disposable Linux machine your agent can drive: shell, filesystem,
ports. Docker when it is there, a guarded local workspace when it is not, and
`husk doctor` tells you which one you got. No account, no card, no telemetry.

**B.** One command gives Claude Code a Linux box mid-conversation. It runs on
your hardware, for free, and nothing leaves the machine except the calls to the
model provider you configured.

**C.** Point it at a chat transcript and it becomes a bot. Point it at your
agent and it becomes a computer. Free, local, Apache-2.0.

**Pick: A.**

It does three jobs in three sentences: says what you get, names the honest
caveat before anyone has to ask, and closes the trust loop. B is tighter but
buries the isolation story, which is the thing that earns us the platform
engineer. C is the cleverest and the least useful — it is a summary of the
README written by someone who has already read the README.

### The hero, assembled

> # Give your agent a computer.
>
> A disposable Linux machine your agent can drive: shell, filesystem, ports.
> Docker when it is there, a guarded local workspace when it is not, and
> `husk doctor` tells you which one you got. No account, no card, no telemetry.
>
> ```bash
> claude mcp add husk -- npx -y @husk-ai/mcp
> ```
>
> Apache-2.0 · works with Claude Code, Cursor, Zed, or anything speaking MCP

No third CTA. No "trusted by". No logo wall. The command is the proof.

---

## 2. First-run CLI output

`husk` with no arguments, on a machine that has never run it. This is the most
important 20 lines of copy in the product: it is where the free path either
proves itself or does not.

```
$ npx -y @husk-ai/cli

husk 0.1.0 · first run · ~/.husk created

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

> **Husk gives any AI agent a computer, and turns any AI chat into a bot.**
>
> A computer is a disposable Linux machine an agent can drive — shell,
> filesystem, ports, snapshots. It runs on Docker if you have it, Podman if you
> prefer, a guarded directory if you have neither, and an SSH box or a Fly
> microVM if you would rather it ran somewhere else. A husk is a `husk.yaml`: an
> agent definition Husk can distill out of a Claude Code, ChatGPT or Cursor
> transcript and then serve over HTTP, Discord, Slack, cron, or the CLI. There
> is no account, no hosted control plane you have to talk to, and no telemetry —
> absent from the codebase, not disabled by a flag. The free path works, and it
> is the same path everything else is built on.
>
> ```bash
> claude mcp add husk -- npx -y @husk-ai/mcp
> ```

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
