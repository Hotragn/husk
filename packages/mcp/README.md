# @husk/mcp

Give any MCP client a Linux computer.

```bash
claude mcp add husk -- npx -y @husk/mcp
```

That is the whole setup. No account, no config file, no API key. Claude Code now has a
shell, a filesystem and ports on a real Linux machine, and the filesystem persists for
the whole conversation.

Works the same in Cursor, Zed, or anything else that speaks MCP:

```json
{
  "mcpServers": {
    "husk": { "command": "npx", "args": ["-y", "@husk/mcp"] }
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

`computer_info` exists so a model spends one turn learning the machine instead of four
probing it with `uname`, `nproc`, `df` and `which python3`.

## Options

```
--session <key>     reuse one machine across calls (default: "mcp")
--provider <name>   docker | podman | local | ssh | fly
--flavor <name>     base | python | node | full
--network <mode>    none | egress | full
--memory <mb>       memory ceiling
--cpus <n>          cpu ceiling
--keep              leave the machine running after the client disconnects
```

Two projects, two machines:

```bash
claude mcp add husk-api  -- npx -y @husk/mcp --session api  --flavor python
claude mcp add husk-web  -- npx -y @husk/mcp --session web  --flavor node
```

## What kind of machine you get

Husk picks the best provider available and **tells the model which one it got**, in the
first tool result:

```
[husk] docker container cmp_8v9z, isolated from the host. /work persists for this session.
```

or, with no Docker running:

```
[husk] local computer cmp_8v9z on real Linux via wsl:Ubuntu. This is a guarded working
directory, NOT a sandbox: /work is jailed and destructive commands are refused, but it
shares the host kernel and network. Start Docker for real isolation.
```

A model that believes it is sandboxed when it is not makes worse decisions than one that
knows, so the note is not optional and it is not softened.

## Cost of installing it

Nothing is created until the first tool call. Adding the server starts a Node process
that registers seven tool schemas and waits — no container, no directory, no network.

## Verify your install

```bash
npx -y @husk/mcp --help      # options, to stderr
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
