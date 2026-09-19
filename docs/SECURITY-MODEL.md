# Husk — the security model

> **[Interactive trust-boundary diagram](../docs/diagrams/05-trust-boundaries.html)** — open locally for pan/zoom, relationship tracing and PNG/SVG export.

What Husk protects you from, what it does not, and how to tell which mode you are in.

Most sandbox products are vague here. Vagueness is how people end up believing they have
containment they do not have, so this page is specific to the point of being unflattering.

## The threat you actually face

You are not defending against a malicious user — you are the user. You are defending
against **your own agent doing something irreversible**, for one of three reasons:

1. **Accident.** The model writes `rm -rf $BUILD_DIR` and `BUILD_DIR` is empty.
2. **Confusion.** It believes it is in `/work` and is actually in your home directory.
3. **Prompt injection.** It read a file, a web page, or an issue comment that told it to
   do something, and it complied. This is the one that matters, because an injected model
   is not making a mistake — it is following instructions competently, toward someone
   else's goal.

Guardrails handle (1) and (2). Only isolation handles (3).

## The two modes

### Isolated — `docker`, `podman`, `fly`

A kernel boundary. The agent runs as uid 1000 in a container with:

- `--cap-drop ALL` and `--security-opt no-new-privileges`
- a read-only root filesystem, with writable layers only at `/work` and `/tmp`
- memory, CPU and pid limits (`--pids-limit 512`, so a fork bomb hits a ceiling)
- the root account locked, no sudo, no setuid path to privilege
- the network policy you declared

An injected model in this mode can wreck the container. It cannot reach your home
directory, your SSH keys, your Docker socket, or your other containers.

`husk doctor` reports `isolated: true`.

### Guarded — `local`

**Not a sandbox.** A guarded working directory. Husk applies real, tested controls:

| control | what it stops |
| --- | --- |
| path jail (file tools) | every file-tool call resolves through `realpath` and is rejected if the target leaves the workspace — including via a symlink created inside it. Shell commands are **not** path-confined: they start in the workspace, but absolute host paths and `..` reach whatever your user reaches. On a Windows host the jail currently errs the other way and refuses *any* symlink inside the workspace, because the host reads those files through `\\wsl.localhost\` and cannot follow a Linux link ([#113](https://github.com/Hotragn/husk/issues/113)) |
| environment scrub | `ANTHROPIC_API_KEY`, `AWS_*`, `*_TOKEN`, `*_SECRET` and everything else not on a small allow-list never reach the process |
| command policy | a short list of unrecoverable commands (`rm -rf /`, `mkfs`, `dd of=/dev/sda`, `curl … \| sh`, `sudo`, fork bombs) is refused |
| output caps | a runaway process cannot exhaust memory through captured output |
| process-tree kill | a timeout kills the whole process group, not just the shell |
| mount namespace (WSL2) | `/work` is bind-mounted per exec inside `unshare -mr`, so the `/work` an agent sees is always this computer's workspace |

What it does **not** stop: the agent shares your kernel, your network, and your user
account. It can reach anything your user can reach that is not specifically blocked. The
command policy is a deny list, and deny lists are bypassable by anyone who is trying.

`husk doctor` reports `isolated: false`, and the MCP server tells the model so in its
first tool result, because a model that believes it is contained when it is not will take
risks it otherwise would not.

## Why the deny list is short

An over-eager deny list gets switched off, and a switched-off deny list protects nobody.

The bar for inclusion is: *no legitimate agent task needs this, and running it by accident
is unrecoverable.* `rm -rf ./build` is allowed. `rm -rf /` is not. `grep -r "sudo" .` is
allowed — matching on the word `sudo` anywhere in a command line rather than in command
position is exactly the false positive that trains people to pass `--no-guardrails`.

Rules are anchored to command position: the start of the line, or after `;`, `|`, `&&`,
`||`, `$(`, `then`, `do`.

## Choosing a mode

```bash
husk doctor
```

It names the provider it will use, whether that provider is isolated, and what to do about
it. It never silently substitutes a weaker provider for the one you asked for — requesting
`--provider docker` with the daemon down is an error, not a downgrade to `local`.

Use `local` for your own code on your own machine. Use `docker` the moment an agent will
read anything you did not write: a scraped page, a dependency, an issue body, a PDF.

## Network policy

Declared per husk:

```yaml
computer:
  network:
    mode: egress
    allow: ['*.github.com', 'pypi.org']
```

- `none` — no egress.
- `egress` — the allow-list only. **An empty allow-list permits nothing**, which is the
  safe reading of an under-specified policy.
- `full` — unrestricted, minus explicit denies.

On `docker`, `none` is enforced by the kernel (`--network none`). On `egress`, hostname
allow-listing is enforced at the tool layer, not by a firewall — a process that opens a
raw socket is not stopped. That is a real limitation and it is why `none` and `full` are
the honest choices when the distinction matters.

## Secrets

Two independent controls:

1. **Nothing credential-shaped enters the machine.** The environment scrub is deny-by-
   pattern over a small allow-list, so a variable you have never heard of is dropped
   rather than forwarded.
2. **Nothing credential-shaped leaves a tool.** Every tool result passes through
   `redact()` before it re-enters the conversation, matching Anthropic, OpenAI, Google,
   GitHub, Slack and AWS access key IDs plus PEM private keys. An agent that `cat`s a
   `.env` sees the file; the model sees `sk-ant-…[redacted]`.

   An AWS *secret* access key is the documented exception: it is forty characters of
   base64 with no prefix and nothing to match on, so no pattern finds it without also
   redacting ordinary hashes. Pair the scrub with `none` egress when that is the
   credential you are worried about.

To pass a credential deliberately, name it:

```yaml
computer:
  env:
    GITHUB_TOKEN: ${GITHUB_TOKEN}
```

Explicit beats implicit, and now it is in the file where a reviewer can see it.

## Approval

```yaml
guardrails:
  approvalMode: ask   # auto | ask | readonly
```

In `ask`, tools marked `dangerous` pause for a human. **If no approver is wired up, the
call is denied, not allowed** — a headless server running an `ask`-mode husk fails closed.
In `readonly`, dangerous tools are never offered.

## What we do not do

- **No telemetry.** Not off by default — absent. No analytics, no crash reporter, no
  phone-home. The only calls Husk makes are to the model provider you configured and to a
  registry when pulling an image.
- **No credential storage.** Husk reads keys from the environment and never writes them to
  `~/.husk`. One thing does land there verbatim: `husk import` caches the transcript you
  gave it, so a chat log containing a key keeps that key in `~/.husk/transcripts`. What
  Husk *derives* from it is redacted first — the distilled `husk.yaml`, its name, its
  slug and its filename — but the cached copy of your own file is not rewritten.
- **No remote execution by default.** `husk serve` binds loopback, and it refuses to start
  on a non-loopback address without `HUSK_TOKEN` set.

## Securing the repository itself

A key that never reaches a model is still a key if it reaches a commit.

`scripts/secret-scan.mjs` reads tracked files and walks `git log -p --all`, so its
coverage is exactly *reachable from a ref* — every branch, tag and note, including a
second root. `.npmrc` is deliberately tracked, because it carries shared settings and
ignoring it would change nothing for a file git already follows; `npm login` writes
`_authToken` into that same file, so the scanner is what covers it.

Three things follow from "reachable from a ref":

- **Deleting a branch or force-pushing is concealment, not remediation.** GitHub serves
  unreachable commits by SHA indefinitely, to anyone who has the SHA. Deletion removes
  those commits from your scanner and from nobody else. Scan an unmerged ref *before*
  deleting it.
- **`--all` includes `refs/stash`**, so a stash entry can be the only thing keeping a
  commit in scope — and `stash@{1}` and older live in a reflog the scan never reaches.
- **A clean scan means nothing without its scope.** Record the ref set and the commit
  count alongside the result, or the result is not repeatable.

If a credential does reach a commit, the remediation is rotating it. Rewriting history
is tidying, and it happens second.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue. Include the
provider, the Husk version from `husk version`, and a reproduction. We will confirm within
a few days and credit you in the fix unless you would rather we did not.
