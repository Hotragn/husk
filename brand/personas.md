# Husk — personas

Four people. Each one is a composite, but every detail is meant to be checkable: if a
claim about them cannot be turned into a command, a file path, or a number, it does not
belong here.

These exist to settle arguments. When someone asks "should the landing page lead with the
MCP line or the import line", the answer is in here, not in taste.

---

## 1. Marcus Ombeni — 29, backend developer, Manchester

### Context

Marcus writes Go for a logistics company that moves pallets around the north of England.
Nine to six, four days a week in an office in Ancoats. The interesting part of his week is
Tuesday and Thursday nights and most of Sunday, when he works on a Discord bot for a
2,400-member server about mechanical keyboards.

Three weeks ago he spent about five hours in Claude Code building out a switch-comparison
helper: he pasted specs, corrected the model eleven times on how to describe tactile
bumps, and ended up with a conversation that answered questions better than anything he
could write a prompt for. That conversation is sitting in
`~/.claude/projects/-home-marcus-code-switchdb/` as a 3.1 MB JSONL file. He has opened it
in `less` twice and closed it both times.

His machine is a 2021 ThinkPad T14 running Pop!_OS 22.04 with Docker installed. His budget
for this project is zero pounds a month, and he means zero — he cancelled a $5 Hetzner box
in January because he was not using it.

### The job they hire Husk for

When I have already had the conversation that solves the problem, I want to turn that
transcript into something my Discord server can talk to, so I can stop being the bot.

### Current workaround

He copy-pastes chunks of the transcript into a `SYSTEM_PROMPT` const in a
`discord.js` project, wires it to `anthropic.messages.create`, and redeploys with
`pm2 restart switchbot`. It mostly works. The bot is live. But the prompt is 900 lines of
pasted conversation with no structure, he has no idea which parts are load-bearing, and
every time he edits it the tone drifts. He has rewritten it from scratch twice.

### What makes them bounce in 60 seconds

- A signup wall, an email field, or a "start free trial" button before the first command.
- Pricing that starts at "free for 100 runs/month". He will read that as a countdown.
- An install that wants Python, a `curl | sh`, or a C++ toolchain.
- A Discord integration that is documented as "coming soon" or lives behind a waitlist.
- Docs that show the config file but never show what the bot actually replied.
- A hosted control plane he has to point his bot at.

### The exact first command they type

```bash
npx -y @husk/cli import ~/.claude/projects/-home-marcus-code-switchdb/8f3c2a91.jsonl
```

He expects a `husk.yaml` in the current directory and a printed path. He expects to be
able to `cat` it immediately and recognise his own conversation in it.

### The moment they decide it is real

The distiller's confidence block. It tells him it derived the persona from recurring
instructions, lists three exemplars it picked because he never corrected them, and then
says what it could not determine — that it could not tell whether he wanted the bot to
answer off-topic questions. That last line is the moment. Nothing he has installed this
year has told him what it did not know.

### What they tell someone else

> "You know that Claude session where I finally got the switch descriptions right. That's
> the bot now. It's a yaml file, I can read the whole thing."

---

## 2. Priya Raghunathan — 36, staff platform engineer, Austin

### Context

Priya owns the internal developer platform at a 400-person payments company. Six weeks
ago three product teams independently started letting agents run shell commands in CI, and
one of them did it by shelling out to `docker run` with the repo bind-mounted read-write.
She found it in a PR review. Her director now wants a one-page recommendation on agent
execution by the end of the sprint, and her security lead, Wes, will read it.

Wes's question is always the same and she can recite it: is this a security boundary, or
does it just feel like one. He has rejected two vendors this year for answering that
question with a marketing page.

Her stack: EKS on us-east-2, Terraform, Buildkite, Podman on the build agents because
they moved off the Docker daemon in 2024, and a Falco ruleset she maintains herself. She
has $0 of discretionary budget until Q1 and a procurement process that takes eleven weeks,
so anything requiring a contract is a next-year conversation regardless of merit.

### The job they hire Husk for

When three teams are already giving agents shell access, I want a defensible answer about
what each execution mode actually contains, so I can write a recommendation that survives
Wes reading it.

### Current workaround

A shared `Dockerfile.agent` in the platform repo, a Buildkite plugin that runs it with
`--network none --read-only --tmpfs /tmp`, and a Confluence page nobody reads. It mostly
works, and she wrote it, so she trusts it. What she does not have is lifecycle: containers
leak, nothing reaps them, and there is no story for the two engineers on Windows laptops.

### What makes them bounce in 60 seconds

- The word "sandbox" on a landing page with no provider named beside it.
- A security page that is a trust-badge grid instead of a threat model.
- A "contact sales" button anywhere in the evaluation path.
- Podman listed as "experimental" or absent from the provider table.
- Any claim of isolation that does not distinguish between the modes it can run in.
- Telemetry described as "anonymous" or "opt-out" rather than absent.

### The exact first command they type

```bash
npx -y @husk/cli doctor
```

On a build agent with no Docker daemon. She expects it to name `podman`, state its
isolation, and state why it chose it over the others — not a green checkmark.

### The moment they decide it is real

She runs `doctor` a second time on a laptop with neither Docker nor Podman, and it selects
`local`, prints `isolated: false`, and says process guardrails are not containment before
she asks. She copies that line verbatim into the recommendation doc. A product that
volunteers its own weakest mode is a product whose strong claims she can quote.

### What they tell someone else

> "It's Docker or Podman underneath, and it says out loud which one you got and whether
> that's a boundary. The local mode is guardrails and it tells you so."

---

## 3. Tomasz Wielgus — 27, PhD candidate in computational linguistics, Kraków

### Context

Third year, working on evaluation of instruction-following in mid-size open models. His
grant covers a desk, a stipend of about 4,600 PLN a month, and no API budget of any kind —
he burned the department's shared OpenAI credit in April and is not asking again.

His machine is a desktop he built: Ryzen 7 5800X, RTX 4090 with 24 GB, 64 GB of RAM,
Ubuntu 24.04. Ollama runs as a systemd unit with `gemma3`, `llama3.2`, and
`qwen2.5-coder` pulled. His experiments live in a git repo with a `requirements.txt`
pinned to the patch version, because a reviewer once asked him to reproduce a number from
a paper draft and he could not.

The thing that is actually annoying him: he needs the models he is evaluating to execute
code and be scored on whether it ran, and his current harness runs that code on the same
machine as the experiment. He has already had one run rewrite a results directory.

### The job they hire Husk for

When I am scoring a local model on whether its code actually runs, I want the execution to
happen somewhere I can throw away and describe in a methods section, so my results are
reproducible and my results directory survives.

### Current workaround

A Python `subprocess.run` with `timeout=30` inside a Docker container he starts by hand
with `docker run -d --rm -v $PWD/work:/work python:3.11-slim sleep infinity`, then
`docker exec` for each candidate. It mostly works. It also silently keeps the same
container across runs, which is exactly the kind of state leak that invalidates a
comparison, and he has no clean way to say in a paper which container it was.

### What makes them bounce in 60 seconds

- Anything requiring an API key to reach a first result, including for a "free tier".
- Ollama listed as an integration rather than as a first-class model provider.
- A version number that is not pinnable, or a `latest` tag in the install line.
- Cost accounting that assumes tokens have a price and shows him `$0.00` with no note that
  local is genuinely zero.
- A silent model substitution when the one he asked for is unavailable.
- Node as a dependency would not bounce him, but a build step that compiles native code
  against his system Python would.

### The exact first command they type

```bash
npx -y @husk/cli@0.1.0 doctor
```

Pinned, on purpose, first try. He expects it to find Docker, find Ollama, list the three
models he actually has pulled, and not mention a key.

### The moment they decide it is real

Mid-run he stops the Ollama unit to see what happens. The router emits a warning event,
names the fallback it is about to use, and does not quietly answer with a different model.
He restarts Ollama and the next step is back on `qwen2.5-coder`. That warning is the
difference between a number he can publish and a number he cannot.

### What they tell someone else

> "It runs the generated code in a Docker container per experiment, the model is
> `ollama/qwen2.5-coder`, and it shouts when it falls back instead of swapping models on
> me."

---

## 4. Dana Okafor — 33, staff engineer, Seattle

### Context

Tuesday, 3:40 pm. Dana is four hours into untangling why a 1.2 GB vendor archive of
Parquet files has a schema that does not match the one in the data contract. She is in
Claude Code, in a repo she cares about, on a MacBook Pro M3 with Docker Desktop running
because it always is.

What she wants is for Claude to untar the thing, poke at it with `duckdb`, and tell her
which column drifted. What actually happens is that Claude proposes a command, she reads
it, she runs it herself in the other terminal pane, she pastes the output back. She has
done this maybe forty times today. She is the clipboard.

She is not evaluating anything. She has no interest in a product. She has a window of
about sixty seconds before she goes back to being the clipboard, because being the
clipboard is annoying but it is working.

### The job they hire Husk for

When I am mid-task and Claude needs to actually run something, I want it to have a machine
of its own that is not my repo, so I can stop pasting terminal output back and forth.

### Current workaround

Two panes: Claude Code on the left, iTerm on the right. She copies the proposed command,
runs it, copies stdout back. For anything destructive she runs it in
`docker run -it --rm -v /tmp/scratch:/w ubuntu bash` first. It mostly works. It works well
enough that she has never gone looking for an alternative — the cost is spread thin across
the whole day, forty seconds at a time.

### What makes them bounce in 60 seconds

- More than one command to install. A second step is a bounce.
- Anything that asks her to restart Claude Code or edit a JSON config by hand.
- A tool that wants access to her actual repo directory by default.
- A first run that stalls for thirty seconds with a spinner and no output.
- An MCP server that registers fourteen tools and floods her context window.
- A prompt asking her to choose a provider before she has seen it work once.

### The exact first command they type

```bash
claude mcp add husk -- npx -y @husk/mcp
```

Pasted from wherever she found it, without reading the surrounding paragraph. She expects
to type it, get one line back, and immediately ask Claude to untar the archive.

### The moment they decide it is real

Two tool calls later. Claude untars into the machine, and then — in a separate call, a
minute after the first — lists the directory and the files are still there. The machine is
keyed to her session, so the conversation kept its filesystem without her tracking an id.
She does not know that is what happened. She just notices she did not have to re-upload
anything, closes the right-hand pane, and keeps working.

### What they tell someone else

> "One line, and Claude Code gets a Linux box. It keeps the files between tool calls. I
> stopped copy-pasting terminal output about an hour in."

---

## What the four have in common

- **They all reach for a terminal before they reach for a browser.** The first thing every
  one of them wants is a command, not a paragraph. Three of the four type their first
  command before reading anything else on the page.
- **Their current workaround mostly works.** None of them is in pain. Every one of them
  has a Docker command or a copy-paste loop that produces correct results today. Husk is
  competing with "fine", not with "broken" — which means the pitch has to be specific
  enough to beat inertia in under a minute.
- **A signup wall ends the evaluation.** Not delays it. Ends it. For Marcus and Tomasz
  it is budget, for Priya it is procurement, for Dana it is that she is mid-task.
- **They punish vagueness harder than they punish limitations.** All four react well to a
  stated weakness and badly to an unqualified claim. `isolated: false` reads as
  trustworthy; "runs safely" reads as a warning.
- **None of them wants a platform.** They want one artifact: a `husk.yaml`, a container, a
  doctor report. Anything that looks like it wants to become their workflow is friction.

## Where they diverge, and what that means for the site

- **Two of them arrive for the computer, two for the bot.** Dana and Priya never care
  about transcripts; Marcus barely cares about providers. *Implication:* the first screen
  carries both halves of the sentence — the MCP line and the import line — as two adjacent
  commands, not as a hero and a subordinate feature. Do not make one of them scroll.
- **Their tolerance for reading varies by an order of magnitude.** Dana gives it 60
  seconds and one command; Priya will read a threat model for twenty minutes and diff the
  provider table against her build agents. *Implication:* one copy-pasteable line above the
  fold for Dana, and a `/security` page dense enough for Priya, linked from the provider
  table rather than from the nav. Neither audience should have to wade through the other's
  content.
- **Only Tomasz cares about the model layer.** Nobody else will read the router docs.
  *Implication:* keep the ten providers and the alias table out of the landing page and put
  them one click deep, but make the Ollama path visible in `doctor` output shown on the
  page — that is where he will look for it.
- **Only Priya needs the concession list to be prominent.** Single-user, no GPUs, no hosted
  control plane, `local` is not a boundary. *Implication:* a "what Husk does not do"
  section that is a real section with a heading, not a footnote — she is looking for it,
  and the other three will skim past it without harm.
- **Windows matters to exactly one of them today, and to hiring tomorrow.** Priya has two
  engineers on Windows laptops and that is a blocking criterion in her recommendation.
  *Implication:* state the clean `npm install` with no native modules on the install page,
  in one sentence, near the command — not in a compatibility matrix at the bottom.
