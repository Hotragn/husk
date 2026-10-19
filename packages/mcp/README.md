# @husk-ai/mcp

Give any MCP client a Linux computer.

```bash
claude mcp add husk -- npx -y @husk-ai/mcp
```

That is the whole setup. No account, no config file, no API key. Claude Code now has a
shell, a filesystem and ports on a real Linux machine, and the filesystem persists for
the whole conversation.

Works the same in Cursor, Zed, or anything else that speaks MCP:

```json
{
  "mcpServers": {
    "husk": { "command": "npx", "args": ["-y", "@husk-ai/mcp"] }
  }
}
```

## Tools

| tool | what it does |
| --- | --- |
| `shell` | run a command; `/work` persists across calls |
| `read_file` | read a text file, with optional line range |
| `write_file` | create or overwrite, creating parent directories |
| `edit_file` | exact-string replace; fails loudly if the match is missing or ambiguous |
| `list_dir` | list a directory |
| `expose_port` | publish a port and get a reachable URL |
| `computer_info` | OS, kernel, CPU, memory, disk, network, installed runtimes |
| `hand_off` | give the computer to the user for a login, 2FA code, CAPTCHA or payment prompt |
| `hand_off_done` | take it back once the user says they are done |

While a handoff is open every other computer tool refuses, so the model cannot type into
the page you are signing in on. Clients that support MCP form elicitation (Claude Code,
Cursor, VS Code) ask "I'm done" in the chat; others get a link to relay, and the model
waits for your word. Nothing resumes on a timeout.

Three prompts ship as one-click starters: **Set up a project**, **Research a topic with
sources** and **Fill out a web form with me**. Claude Code lists them as `/husk:<name>`.

`computer_info` exists so a model spends one turn learning the machine instead of four
probing it with `uname`, `nproc`, `df` and `which python3`.

## Options

```
--session <key>     reuse a named machine (default: unique to this server process)
--provider <name>   docker | podman | local | ssh | fly
--flavor <name>     base | python | node | full
--network <mode>    none | egress | full
--memory <mb>       memory ceiling
--cpus <n>          cpu ceiling
--keep              leave the machine running after the client disconnects
```

Two projects, two machines:

```bash
claude mcp add husk-api  -- npx -y @husk-ai/mcp --session api  --flavor python
claude mcp add husk-web  -- npx -y @husk-ai/mcp --session web  --flavor node
```

## One computer per chat

Each chat gets its own computer, made on its first Husk call. How Husk tells chats
apart depends on what the app provides:

| app | signal | result |
| --- | --- | --- |
| Claude Code | `CLAUDE_CODE_SESSION_ID`, one server process per session | one computer per session, no id needed |
| `--session <key>` | your key | one durable, named computer |
| anything else (Claude Desktop, Cursor, ...) | none; one process may serve every chat | the first call passes `computer: "new"` and gets an id; later calls pass that id |

A call with no id never reuses a computer, because it could be another chat's first
call: it creates one only while none exists yet, and otherwise creates nothing and asks
the model to pass its id, without naming the others. An id from outside this server
process is refused. Each computer is labelled like "Claude Desktop · chat started
10:42", from the app's own name and the time, never from the chat's title or content.

## What kind of machine you get

Husk picks the best provider available and **tells the model which one it got**, in the
first tool result:

```
[husk] docker container cmp_8v9z, isolated from the host. /work persists for this session.
```

or, with no Docker running:

```
[husk] local computer cmp_8v9z on real Linux via wsl:Ubuntu. This is a guarded working
directory, NOT a sandbox: file tools are confined to /work and destructive commands are
refused, but shell commands can still reach anything your user can on the host --
filesystem, kernel and network. Keep secrets and untrusted input out of it.
```

A model that believes it is sandboxed when it is not makes worse decisions than one that
knows, so the note is not optional and it is not softened.

## Cost of installing it

Nothing is created until the first tool call. Adding the server starts a Node process
that registers seven tool schemas and waits — no container, no directory, no network.

## Verify your install

```bash
npx -y @husk-ai/mcp --help      # options, to stderr
node dist/smoke.js           # drives every tool against a real machine
```

The smoke test creates a computer, exercises each tool, checks that a destructive command
is refused and that a path outside `/work` is rejected, then destroys the machine.

## Notes

- stdout is the JSON-RPC stream. All logging goes to stderr; a stray `console.log` would
  corrupt the protocol and silently kill the client.
- Closing stdin shuts the server down and destroys the machine, so a crashed client does
  not leave a container running.
- `--keep` opts out of that, for a machine you want to reattach to.

## Reconnects and health checks

A stopped computer is started again before use, preserving its workspace. The MCP
server checks a cached computer before each tool call. An unavailable engine or a
failed health probe is reported as an error; a connection alone does not mean the
computer is ready. Run `husk doctor` under the same account as the MCP client to
check provider access. On Windows, start Docker Desktop and check `docker info`.

Each server process gets its own session key by default so separate clients do
not stop or reuse each other’s computer. Use `--session <key> --keep` (or
`HUSK_SESSION` with `--keep`) to reconnect to a named workspace. Clients that
explicitly share a key must use `--keep` to avoid destroying it on disconnect.
A client that shares one MCP process across chats also shares that computer.

The optional viewer is separate: `viewer not running` only means `husk serve`
is not available. It does not describe the container’s health.
