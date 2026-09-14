# @husk/cli

The `husk` command line. Gives your agent a disposable Linux computer, and turns
a chat into a bot.

```bash
npm install -g @husk/cli
```

Node >= 20.10. No native modules, so `npm install` is clean on Windows.

## Sixty seconds

```console
$ husk doctor
husk 0.1.0  node 24.14.0 · win32-arm64

COMPUTERS
  ✗ docker   isolated
      docker is installed but the daemon is not reachable
      fix: start Docker Desktop (or `sudo systemctl start docker`), then re-run `husk doctor`
  ✓ local    not isolated
      A guarded working directory on this machine. Free, always available, not isolated.
      via WSL2 (Ubuntu)

SELECTION  what husk would use right now
  computer   local  highest-priority available provider (10)
  isolation  guardrails only
  model      ollama/qwen2.5:7b  first reachable model on Ollama

$ husk up scratch
✓ scratch is up

  id         cmp_jwhzm6carxtq
  provider   local  (WSL2 (Ubuntu))
  isolation  guardrails only — not a sandbox
  workdir    /work

$ husk exec scratch -- 'echo hi > /work/a.txt; cat /work/a.txt; uname -sr'
hi
Linux 6.18.33.2-microsoft-standard-WSL2

$ husk rm scratch --yes
✓ destroyed scratch
```

No account, no API key, no Docker. `husk doctor` is the command to run when
anything is confusing — it tells you what is available, what is not, and the one
command that fixes each gap.

## Commands

Run `husk help <command>` for flags and examples. Every command has both.

**Computers** — `up` `ps` `rm` `stop` `start` `exec` `shell` `cp`
**Agents** — `init` `run` `validate`
**Chats** — `import` `distill`
**System** — `doctor` `serve` `mcp` `models` `version`

## Built for pipes as well as people

`--json` is on every read command, and it is the **only** thing on stdout when
set. Spinners, progress and warnings all go to stderr.

```console
$ husk ps --json | jq -r '.[].name'
scratch

$ husk doctor --json | jq -r '.selection.isolated'
false

$ husk exec scratch --json -- 'ls /work' | jq .exitCode
0
```

Piped output is tab-separated with no padding and no colour, so `cut` and `awk`
work:

```console
$ husk ps | cut -f1,4
name	state
scratch	running
```

Colour follows `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb` and `--no-color`, and turns
itself off when stdout is not a terminal.

## Exit codes

| code | meaning |
| --- | --- |
| `0` | success |
| `1` | the command failed |
| `2` | you used it wrong — bad flag, missing argument, unknown command |
| `130` | interrupted with Ctrl-C |

`husk exec` is the deliberate exception: it exits with **the command's own exit
code**, so this works —

```bash
husk exec scratch -- test -f /work/report.csv && echo present
```

Ctrl-C during a run stops it cleanly between steps. It does not destroy the
computer; your files are still there.

## Errors name the fix

```console
$ husk exec ghost -- ls
error no computer named "ghost"
hint:  running now: scratch, builder
```

One red line, one dim hint. Never a stack trace — pass `--debug` when you want
one. If an error ever leaves you without a next step, that is a bug worth filing.

## Isolation, honestly

`local` is **guardrails, not a sandbox**. It pins the working directory, rejects
path escapes, scrubs credential-shaped environment variables, caps output, and
kills the process tree on timeout. That stops accidents. It will not stop a
determined adversary, and a prompt-injected model is closer to an adversary than
to an accident.

`husk doctor` prints `isolated: false` and the first run says so out loud. Start
Docker for kernel-level isolation before running anything you did not write.

On Windows, `local` runs inside WSL2 when it is available, so `/work` is a real
Linux filesystem and `uname` says Linux. Without WSL it falls back to the Windows
shell and `husk doctor` warns you that it is not a Linux computer.

## Chat to bot

```console
$ husk import
Found 12 transcripts

  #  SOURCE       WHAT                             SIZE    MODIFIED
  1  claude-code  home/me/api  4f2a91c3             184KB   2026-09-08
  2  chatgpt      conversations.json               2.1MB   2026-09-01
  3  markdown     support-chat.md                  4KB     2026-08-30

? import which? [1-12, or q to quit] 3
✓ imported support-chat.md

$ husk distill tr_01hxyz --no-model --out support-bot.yaml
✓ wrote support-bot.yaml

EXTRACTED
  name         support-triage-bot
  tools        files
  confidence   ███░░░░░░░ 30%

$ husk run support-bot.yaml "my order hasn't arrived"
```

`--no-model` forces the free heuristic path even when a key is configured, so
"does this work with no API key?" is answerable in one command. The confidence
bar is honest: read the persona before you serve it.

## Speed

`husk --help` costs about **16 ms** on top of Node's own startup (95 ms total on
the machine this was built on). Every command is behind a dynamic `import()`, so
you only pay for the one you ran — `bin.js` imports nothing but the argument
parser and the output helpers. There is a startup budget in the test suite so a
dependency cannot silently regress it.

## Privacy

No telemetry. Not "off by default" — absent. Nothing leaves your machine except
calls to the model provider you configured. State lives in `~/.husk`; delete that
directory to reset husk completely.

## MCP

```bash
claude mcp add husk -- npx -y @husk/mcp
```

That gives Claude Code — or Cursor, or Zed, or anything speaking MCP — a Linux
computer mid-conversation, with no account and no config file. `husk mcp` runs
the same server directly on stdio.
