# @husk-ai/mcp

Give any MCP client a Linux computer.

```bash
claude mcp add husk -- npx -y @husk-ai/mcp
```

That is the whole setup. No account, no config file, no API key. Claude Code now has a
shell, a filesystem and ports on a real Linux machine, and the filesystem persists for
the whole conversation.

Works the same in Cursor, Gemini CLI, or anything else that speaks MCP. Zed names the
key `context_servers`, and VS Code `servers`; [docs/clients.md](../../docs/clients.md)
has each app's file, what it supports, and how Husk is checked against it.

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
| `browse` | fetch a public page from inside the computer, as text plus its links |
| `computer_info` | OS, kernel, CPU, memory, disk, network, installed runtimes |
| `browser_*` | fifteen tools that drive a real Chromium inside the same computer, by accessibility ref: `browser_goto`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_hover`, `browser_scroll`, `browser_upload`, `browser_wait_for`, `browser_screenshot`, `browser_tabs`, `browser_status`, `browser_run` (several steps in one call) and `browser_script` (a short Python script with control flow, run inside the computer) |
| `hand_off` | give the computer to the user for a login, 2FA code, CAPTCHA or payment prompt |
| `hand_off_done` | take it back once the user says they are done |
| `computer_open_ui` | a link the chat can give you to watch the computer and take it over |

The `computer` profile (the default) lists these 26 tools plus eight workspace tools; apps that render the computer card also get its two app-only tools, and apps that give up on a long call get `job_wait`. `--profile starter` lists the workspace tools only.

While a handoff is open every other computer tool refuses, so the model cannot type into
the page you are signing in on. Clients that support MCP form elicitation (Claude Code,
Cursor, VS Code) ask "I'm done" in the chat; others get a link to relay, and the model
waits for your word. Nothing resumes on a timeout.

Most apps give up on a tool call after a while: Claude Desktop after 240 s, Zed after
60 s. Husk answers first. A call still running by then says so, with a job id, and goes
on in the computer; `job_wait` collects its result. An app that waits as long as a call
takes, such as VS Code, never sees `job_wait`.

Three prompts ship as one-click starters: **Set up a project**, **Research a topic with
sources** and **Fill out a web form with me**. Claude Code lists them as `/husk:<name>`.

`computer_info` exists so a model spends one turn learning the machine instead of four
probing it with `uname`, `nproc`, `df` and `which python3`.

## Options

```
--session <key>     reuse a named machine (default: unique to this server process)
--provider <name>   docker | podman | local | ssh | fly
--flavor <name>     base | python | node | full
--network <mode>    none | egress | full (default: full, minus internal addresses)
--profile <name>    computer (all tools; default) | starter (workspace tools only)
--daemon            run the shared Husk every chat goes through (started for you on the
                    first tool call; HUSK_DAEMON=off keeps tools in each chat's process)
--memory <mb>       memory ceiling
--cpus <n>          cpu ceiling
--keep              leave the machine running after the client disconnects
```

Two projects, two machines:

```bash
claude mcp add husk-api  -- npx -y @husk-ai/mcp --session api  --flavor python
claude mcp add husk-web  -- npx -y @husk-ai/mcp --session web  --flavor node
```

## The computer card

In apps that render MCP Apps (Claude Desktop, claude.ai, Cursor, VS Code, ChatGPT), a
small card shows up in the chat when its computer starts (`computer_info`) and when it
hands off (`hand_off`): **Computer running · Open**, or **Waiting for you · Take over**.

- The card is a sandboxed `ui://husk/computer-card.html` view that makes no network
  requests. It reaches Husk only through the app, calling two app-only tools
  (`computer_card_state`, `computer_card_link`), and asks the app to open the link it
  gets back.
- That link carries a short-lived token scoped to that one computer, so a card in one
  chat cannot open another chat's computer. It never carries the server token.
- Apps that do not render cards never see those two tools. They get
  `computer_open_ui`, which returns the same link as text.

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

A chat's computer is never removed by Husk:

- **Idle:** after 10 minutes with no Husk call it is stopped, using no CPU or memory.
  The chat's next call starts it again.
- **Restart:** when the app or the PC restarts, the chat still holds the id, and that id
  wakes the same computer with its `/work` files and installed packages. Only ids bound
  as a chat's computer in `~/.husk/computers/bindings.json` are woken; any other id is
  refused.
- **Disconnect:** the computer is stopped, not destroyed. `--keep` leaves it running.
- **Delete:** only from the console's Computers table, after a confirmation. The table
  shows each computer's app, chat label, last-used time and disk size.

## One Husk for every chat

Every chat's computer tools run in one shared Husk on this machine, the same process as
`husk serve`. It holds each chat's browser, so its console shows every chat's computer,
the live browser and the last thing each one did, and a handoff from any chat is taken
over there. The first computer tool call starts it if nothing is running
(`husk-mcp --daemon`, detached, logging to `~/.husk/daemon.log`) and finds it through
`~/.husk/daemon.json`, which holds its address and token and is readable only by you.

A chat falls back to running its tools in its own process, as before, when
`HUSK_DAEMON=off` is set, when the shared Husk is a different version, or when one
cannot be started. Its tools still work then; the console just cannot see that chat.

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
