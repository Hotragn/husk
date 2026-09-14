# Security

## Reporting a vulnerability

Email **security@husk.sh** rather than opening a public issue. Include what you did,
what happened, and what you expected. We aim to acknowledge within 72 hours.

Please do not test against infrastructure you do not own. Husk is designed to run on
your own machine; that is where it should be tested.

## What Husk guarantees, and what it does not

The full analysis is in [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md). The short
version, because a security page that buries the caveat is not a security page:

**The `local` provider is not a sandbox.** It is a guarded working directory. It pins
the working directory, resolves every path through `realpath` and refuses escapes,
scrubs credential-shaped environment variables, caps output, kills the process tree on
timeout, and refuses a deny list of unrecoverable commands. That stops accidents. It
does not stop an adversary. `husk doctor` reports `isolationKind: guardrails` for it,
and the CLI says so before you use it.

**A prompt-injected model is closer to an adversary than to an accident.** If an agent
reads a web page, a README, or a log line that contains instructions, treat everything
it does next as attacker-influenced. Run it on `docker`, `podman` or `fly`, where the
boundary is the kernel.

**`ssh` is isolated from your laptop, not from the remote box.** The agent holds your
user's shell there. `husk doctor` renders this as "isolated from this machine" rather
than a plain "isolated", because the difference matters.

## Controls that are on by default

| control | what it does |
| --- | --- |
| Path jail | `/work` and `/tmp` only; `..` traversal and escaping symlinks both refused |
| Env scrubbing | `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `AWS_*` and friends never reach a command |
| Command policy | a deny list of unrecoverable commands, anchored to command position |
| Network floor | loopback, link-local and RFC1918 refused **even in `network.mode: full`** |
| Secret redaction | tool output passes through `redact()` before it re-enters the conversation |
| Budgets | step, cost, token and wall-clock ceilings, all checked *before* a model call |
| Approval | `ask` mode fails closed — no approver wired means the call is denied |

### The network floor, specifically

`mode: 'full'` means the internet. It does not mean `169.254.169.254`, the cloud
metadata endpoint that hands IAM credentials to anything that asks. An operator who
genuinely needs an internal host names it in `network.allow`, where a reviewer reading
the `husk.yaml` can see the decision.

## No telemetry

Not "off by default" — absent. There is no analytics code, no crash reporter, no
phone-home.

Verify it yourself:

```bash
grep -rhoE "https://[a-zA-Z0-9._-]+" packages/*/src --include=*.ts | sort -u
```

Every host that returns is one of four things: a model provider you configured
(`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, …), a
chat platform you explicitly wired a bot into (`discord.com`, `slack.com`,
`api.telegram.org`), a search backend the `web` tool only uses when you supply its key
(`api.search.brave.com`, `api.tavily.com`), or Fly's API when you set `FLY_API_TOKEN`.
Nothing is contacted that you did not turn on, and there is no endpoint belonging to us.

## Supply chain

No native modules and a deliberately small dependency surface — `zod`, `yaml`,
`fastify`, `ws`, and the MCP SDK. The wire-format translation for every model provider
is written in this repo rather than pulled from ten vendor SDKs, which is more code but
a much smaller attack surface.
