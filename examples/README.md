# Examples

Real husks, not toys. Each one is a single file you can read, edit, and run.

| file | what it is | needs |
| --- | --- | --- |
| [`ci-triage.yaml`](ci-triage.yaml) | reads failing CI logs and says what broke | an API key, or a local model |
| [`data-notebook.yaml`](data-notebook.yaml) | answers questions about local CSVs by writing Python | Ollama only — no key, no network |
| [`support-triage.yaml`](support-triage.yaml) | drafts replies to inbound support mail | an API key, Discord optional |

## Running one

```bash
husk run examples/data-notebook.yaml "what's in data/sales.csv?"
```

Nothing is installed and no machine is created until the husk actually reaches for a
tool, so `husk run` on a question it can answer from its persona costs one model call.

## Serving one

```bash
husk serve
curl -X POST localhost:7377/v1/husks/ci-triage/run \
  -H 'content-type: application/json' \
  -d '{"input":"why is main red?"}'
```

Triggers declared in the file come up with it — the `cron` block in `ci-triage.yaml`
starts polling as soon as `husk serve` loads it.

## Writing your own

Do not start from a blank file. Start from a conversation you have already had:

```bash
husk import          # lists your Claude Code / ChatGPT transcripts
husk distill 3       # turns one into a husk.yaml
```

The distiller reads the instructions you repeated, the corrections you made, and the
tools you actually used. `ci-triage.yaml` began that way — most of its persona is text
I had already typed into Claude Code four separate times.

Then edit it. The generated file is a starting point with an honest confidence score,
not an oracle.

## Anatomy

```yaml
name: ci-triage          # lowercase, dashes -- this is the URL and the CLI handle
model: sonnet            # alias, or provider/model
fallbackModels: [gemma]  # tried in order on 429, outage, or budget
persona: |               # the system prompt
knowledge: []            # stable reference text, appended to the prompt
examples: []             # few-shot pairs
tools: [computer, files] # bundles: computer, files, web, http
computer:                # the machine: flavor, packages, network, limits
limits:                  # steps, cost, tokens, wall clock
guardrails:              # approval mode, denied commands, out-of-scope topics
triggers:                # http, cron, discord, slack, telegram, webhook, cli
```

`husk validate examples/ci-triage.yaml` checks a file without running it.
