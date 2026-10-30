# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting rather than opening a public issue:
**[Report a vulnerability](https://github.com/Hotragn/husk/security/advisories/new)**.
That channel is private between you and the maintainers, and it is the only one
monitored.

Include what you did, what happened, and what you expected. Expect an
acknowledgement within 72 hours.

Please do not test against infrastructure you do not own. Husk is designed to run on
your own machine; that is where it should be tested.

## Supported versions

Husk is pre-1.0. All eleven packages share one version and the release workflow
publishes them together, so there is one supported line and it is the latest
`0.1.x`. Nothing is backported to an earlier patch: on anything older, the
upgrade is the fix.

| version | supported |
| --- | --- |
| latest `0.1.x` | yes |
| any earlier `0.1.x` | no — upgrade |

Expect that to change at 1.0, when a released minor is worth holding open.

## What Husk guarantees, and what it does not

The full analysis is in [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md). The short
version, because a security page that buries the caveat is not a security page:

**The `local` provider is not a sandbox.** It is a guarded working directory. Its file
tools resolve every path through `realpath` and refuse escapes, shell commands start in
the workspace, credential-shaped environment variables are scrubbed, output is capped,
the process tree is killed on timeout, and a deny list of unrecoverable commands is
refused. That stops accidents. It does not stop an adversary: a shell command can still
read and write anything your user can, including outside the workspace. `husk doctor` reports `isolationKind: guardrails` for it,
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
| Path jail (file tools) | `/work` and `/tmp` only; `..` traversal and escaping symlinks both refused |
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
