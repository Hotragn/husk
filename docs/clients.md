# MCP clients: what each one supports

What Husk can rely on in each chat app, and where that comes from. **Official** means
the app's or the protocol's own current docs. **Source** means the app's released
source code, at the tag named. **Community** means a forum post, issue or blog, and is
a lead, not a fact. "Not documented" means we looked and found nothing. Checked 26
October 2026; re-check before depending on a cell.

## The support matrix

Every app below starts Husk on this machine over stdio. `husk setup` connects each one
it can; the console's Connect page does the same.

| App | How it gets Husk | Where |
| --- | --- | --- |
| Claude Code | setup runs `claude mcp add --scope user husk -- …` | `~/.claude.json` |
| Claude Desktop | setup edits its file | `claude_desktop_config.json` in `~/Library/Application Support/Claude/` or `%APPDATA%\Claude\`, under `mcpServers` |
| Codex: CLI, IDE extension and the ChatGPT desktop app, which share one file | setup runs `codex mcp add husk -- …` | `~/.codex/config.toml`, as `[mcp_servers.husk]` |
| Cursor | setup edits its file | `~/.cursor/mcp.json`, under `mcpServers` |
| VS Code | setup edits its file | the profile's `mcp.json` (`%APPDATA%\Code\User\`, `~/Library/Application Support/Code/User/`, `~/.config/Code/User/`), under `servers`, with `"type": "stdio"` |
| Windsurf, now Devin Desktop | setup edits its file | `~/.codeium/windsurf/mcp_config.json`, under `mcpServers` |
| Zed | setup edits its settings in place, keeping their comments | `settings.json` in `~/.config/zed/` or `%APPDATA%\Zed\`, under `context_servers` |
| Gemini CLI | setup edits its file | `~/.gemini/settings.json`, under `mcpServers` |
| Perplexity for Mac | by hand, in the app: **Plugins**, **Add custom**, then a name and the command `npx -y @husk-ai/mcp@~0.2` | inside the app |

Every file setup edits is backed up first, and only Husk's own `husk` entry changes.

Husk speaks both protocol eras on one stdio connection, through the MCP SDK's
`serveStdio`:
- **2025-11-25 and before.** The app opens with `initialize` and is served as before.
- **2026-07-28.** There is no handshake: the app opens with `server/discover`, and every
  request says which app sent it. Husk reads the app's name and capabilities from each
  request. Its "Done?" comes back as an `input_required` result, and the app calls
  again with the person's answer.

What each app does with Husk once it is connected:

| App | Calls itself | Protocol | "Done?" in the chat | Limit on one tool call | Husk answers within |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | 2026-07-28 from its v2 runtime, 2025-11-25 before it or with `MCP_PROTOCOL_NEGOTIATION=legacy` | yes, by `input_required` on 2026-07-28 | about 28 hours, but a stdio call quiet for 30 minutes ends | 25 minutes |
| Claude Desktop | `claude-ai` (community) | 2025-11-25 (community) | no: declared, not shown | 240 s, progress or not | 220 s |
| Claude Desktop's Code tab | `local-agent-mode-<server>` (community) | not documented | no: not declared | 60 s (community) | 50 s |
| Codex | `codex-mcp-client` | 2025-06-18 | no: declared, not known to be shown | 300 s in its source; 60 s in its docs and before June 2026 | 50 s |
| Cursor | not documented; `cursor-vscode` (community) | not documented | yes | about an hour in the editor; 60 s in its CLI (community) | 50 s |
| VS Code | `Visual Studio Code` | 2025-11-25 | yes | none | no limit |
| Windsurf, Devin Desktop | not documented | not documented | no | not documented | 50 s |
| Zed | `Zed` | 2025-11-25 | no: not supported | 60 s, or the entry's own `timeout` in seconds; progress does not extend it | 50 s |
| Gemini CLI | `gemini-cli-mcp-client` | 2025-06-18 | no: not declared | 600 s; progress does not extend it | 540 s |
| Perplexity for Mac | not documented | not documented | no | not documented | 50 s |

**Husk answers within** is how long Husk holds a tool call before it answers that the
call is still running, with a job id. The call goes on in the computer, and `job_wait`
collects its result. It is set under each app's own limit. Where the limit is unknown,
or differs between versions of one app, Husk takes the shortest: an app it does not
know gets the MCP SDK's default of 60 s, less a margin. An app with no limit never sees
`job_wait`. The values live in `chatClient` in `packages/core/src/chat-identity.ts`.

**Tool limits.** Husk's tool names are short, lowercase and snake_case, and fit each
app's limits:
- Devin Desktop's Cascade: 100 tools in all.
- VS Code: 128 tools per request.
- Cursor: 60 characters for server and tool name together.
- Gemini CLI: 63 characters for `mcp_<server>_<tool>`.
- Zed: 64 characters, with no server prefix unless two servers clash.
- Codex: 128 characters for `mcp__<server>__<tool>`.

### How it is checked

`scripts/e2e-computers.mjs` (step 1f) checks every row on a real Docker computer in CI:

1. `husk setup` writes each app's own file in a home of its own. Zed's file starts with
   comments, which must survive.
2. Each app's chat starts Husk from the entry setup wrote. Claude Code and Codex, whose
   CLIs CI does not have, use the same launch line. The chat opens with the app's own
   name, protocol version and capabilities from the table. Claude Code opens twice:
   on 2026-07-28 with `server/discover`, and on 2025-11-25 with `initialize`.
3. Husk must:
   - answer in a protocol version the app speaks;
   - list tools within every app's limits, with `job_wait` only where the app has a limit;
   - give the chat a computer labelled with the app's name;
   - ask "Done?" in the chat only where the app shows it, and give a link to relay
     everywhere else. On 2026-07-28 it asks by `input_required`, and the app's second
     call, with the answer, hands the computer back.
4. In Zed's chat, a 58 s command answers "still running" before Zed's 60 s, and
   `job_wait` collects the rest.

This checks Husk against what each app sends, not the apps themselves. Cells marked
community or not documented, and each app's real behaviour, are confirmed in the real
apps before a release, with the probe in
[evals/running-the-checks.md](evals/running-the-checks.md).

## Summary

| | Claude Code | Claude Desktop | claude.ai | Cursor | VS Code | ChatGPT |
| --- | --- | --- | --- | --- | --- | --- |
| Transport | stdio, Streamable HTTP | stdio (local), Streamable HTTP (connectors) | Streamable HTTP, remote only | stdio, SSE, Streamable HTTP | stdio, Streamable HTTP, SSE fallback | Streamable HTTP, SSE, remote only |
| Session scoping | one process per session, `CLAUDE_CODE_SESSION_ID` | one process for all chats (community) | n/a (remote) | one process per configured server (community) | not documented | n/a (remote) |
| MCP Apps cards | no | yes | yes | yes | yes | yes |
| Elicitation | form and URL | not documented; reported not shown (community) | not documented | yes, mode not documented | form; URL in 1.107 | not documented |
| Prompts | yes, as `/server:prompt` | yes, in the "+" menu | yes, in the "+" menu | yes, how shown not documented | yes, as `/server.prompt` | not documented |
| `tools/list_changed` | yes | not documented | not documented | not documented; reported ignored (community) | implied, not named | no; refresh by hand |

How Husk uses this:
- **Chat identity.** Claude Code's session id gives one computer per session with no
  id from the model. Everywhere else the chat carries its own computer id. See
  [packages/mcp/README.md](../packages/mcp/README.md).
- **In-chat "I'm done".** Offered only to clients that declare form elicitation and
  that `chatClient` in `packages/core/src/chat-identity.ts` knows to show it; everyone
  else gets the handoff link to relay.
- **Computer card.** Shown where MCP Apps render; elsewhere, `computer_open_ui` gives
  the same link as text. Claude Code gets the link.
- **`list_changed`.** Sent when the tool list really changes, such as a degraded host.
  It is never relied on: a client that ignores it keeps the original descriptions.

## Claude Code

- **Transport**, official: HTTP is "the recommended option for connecting to remote
  MCP servers", and SSE is deprecated. https://code.claude.com/docs/en/mcp
- **Session scoping**, official: `CLAUDE_CODE_SESSION_ID` is set in stdio MCP server
  subprocesses, and the server keeps the id it was spawned with.
  https://code.claude.com/docs/en/env-vars
- **MCP Apps**, official: not rendered; UI resources are hidden from the `@` list.
  https://code.claude.com/docs/en/mcp
- **Elicitation**, official: form mode shows a dialog and URL mode asks to open a link.
  It declares both on protocol revision 2026-07-28; what it declares on 2025-11-25 is
  not documented. https://code.claude.com/docs/en/mcp
- **Prompts**, official: listed as `/servername:promptname (MCP)`.
  https://code.claude.com/docs/en/mcp
- **`list_changed`**, official: Claude Code "fetches the updated list from that server".
  https://code.claude.com/docs/en/mcp
- **Timeouts**, official: `MCP_TOOL_TIMEOUT` defaults to about 28 hours; a stdio server
  that sends nothing for 30 minutes is treated as idle.
  https://code.claude.com/docs/en/env-vars

## Claude Desktop

- **Transport**, official: local servers over stdio
  (https://modelcontextprotocol.io/docs/develop/connect-local-servers); remote
  connectors over Streamable HTTP, with legacy HTTP+SSE also supported
  (https://claude.com/docs/connectors/building).
- **Session scoping**, community: one stdio process per configured server, shared by
  every chat. https://timbenniks.dev/writing/claude-desktop-mcp-lifecycle-is-broken
  Not in official docs; `scripts/mcp-probe.mjs` checks it.
- **MCP Apps**, official: interactive connectors render on Claude web, desktop and
  mobile. https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude
- **Elicitation**: not documented. Community reports say Desktop declares the
  capability and never shows the dialog: https://github.com/anthropics/claude-code/issues/41110
- **Prompts**, official: supported, in the "+" menu under Connectors.
  https://claude.com/docs/connectors/building
- **`list_changed`**: not documented. Community: a manual "Refresh tools list" item.
  https://help.usewheelhouse.com/en/articles/15908885-refreshing-your-claude-connector-to-get-new-tools
- **Timeouts**, official: 240 seconds per tool call. https://claude.com/docs/connectors/building

## claude.ai

- **Transport**, official: remote only. Connectors "run on Anthropic's infrastructure",
  so a server needs a public URL. https://claude.com/docs/connectors/building/troubleshooting.md
- **Session scoping**: not applicable to a local process. A remote server can use
  `Mcp-Session-Id` on Streamable HTTP.
  https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- **MCP Apps**, official: rendered.
  https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude
- **Elicitation**: not documented.
- **Prompts**, official: supported. https://claude.com/docs/connectors/building
- **`list_changed`**: not documented.
- **Timeouts**, official: 240 seconds per tool call. https://claude.com/docs/connectors/building

## Cursor

- **Transport**, official: "Cursor supports three transport methods": stdio, SSE and
  Streamable HTTP. https://cursor.com/docs/context/mcp
- **Session scoping**, community: one client per configured server.
  https://forum.cursor.com/t/mcp-server-race-condition-causes-infinite-process-spawning-on-windows-cursor-2-0-34/139610
- **MCP Apps**, official: supported. https://cursor.com/docs/mcp
- **Elicitation**, official: listed as supported; mode not documented.
  https://cursor.com/docs/context/mcp
- **Prompts**, official: listed as supported; how they appear is not documented.
  https://cursor.com/docs/context/mcp
- **`list_changed`**: not documented. Community reports say it is ignored
  (https://forum.cursor.com/t/mcps-tool-list-changed-not-picked-up/132363) or flaky
  (https://forum.cursor.com/t/mcp-tool-list-caching/174607).

## VS Code (GitHub Copilot agent mode)

- **Transport**, official: it "first tries the HTTP Stream transport and falls back to
  SSE"; stdio for local servers.
  https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- **Session scoping**: not documented.
- **MCP Apps**, official: supported.
  https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- **Elicitation**, official: form mode since 1.102; URL mode listed in 1.107.
  https://code.visualstudio.com/updates/v1_107
- **Prompts**, official: "Type `/<MCP server>.<prompt>` in the chat input".
  https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- **`list_changed`**, official but indirect: "VS Code also supports dynamic tool
  discovery" (https://code.visualstudio.com/api/extension-guides/ai/mcp). The
  notification is never named, and "MCP: Reset Cached Tools" exists for when tools
  change.

## Claude Desktop's Code tab

- **Name and capabilities**, community: local servers see the client as
  `local-agent-mode-<server>`. It declares roots and the MCP Apps extension, and no
  elicitation. https://github.com/anthropics/claude-code/issues/96043
- **Timeouts**, community: the MCP SDK's 60 s default.
  https://github.com/anthropics/claude-code/issues/63379

## Codex

- **Config**, official: `~/.codex/config.toml`, or `.codex/config.toml` in a trusted
  project, as `[mcp_servers.<name>]` with `command`, `args`, `env`, `env_vars`, `cwd`,
  `startup_timeout_sec` and `tool_timeout_sec`. "The ChatGPT desktop app, Codex CLI,
  and IDE extension share this configuration." https://learn.chatgpt.com/docs/extend/mcp
- **Name, protocol and capabilities**, source: `codex-mcp-client` (title "Codex"),
  2025-06-18, elicitation declared. openai/codex `rust-v0.164.0`,
  `codex-rs/codex-mcp/src/rmcp_client.rs`
- **Timeouts**, source: 300 s per tool call and 30 s to start, in the same file. The
  docs above still say 60 s and 10 s, as releases before June 2026 had it; progress
  does not extend either.

## Windsurf, now Devin Desktop

- **The rename**, official: "On June 2, 2026, Windsurf is becoming Devin Desktop", as an
  update of the same app, which "reads from both legacy (Windsurf/Codeium) and new
  (Devin) file paths during the transition period".
  https://docs.devin.ai/desktop/devin-desktop-faq
- **Cascade**, official: its own file is `~/.config/devin/mcp_config.json`
  (`%APPDATA%\devin\mcp_config.json`), `mcpServers` with `command`, `args` and `env`.
  "Cascade has a limit of 100 total tools". https://docs.devin.ai/desktop/cascade/mcp
- **Devin Local**, official: imports the servers in
  `~/.codeium/windsurf/mcp_config.json` (and Claude Code's, Cursor's and Zed's files)
  unless `read_config_from` turns that off.
  https://docs.devin.ai/cli/reference/configuration/read-config-from
- So Husk keeps writing the Windsurf file, which both agents read. Its name, protocol
  and timeouts are not documented.

## Zed

- **Config**, official: `context_servers` in `settings.json`, each with `command`,
  `args` and `env`. "Zed currently supports MCP's Tools and Prompts features", so no
  elicitation. https://zed.dev/docs/ai/mcp
- **Where**, source: `~/.config/zed/` on macOS and Linux, `%APPDATA%\Zed\` on Windows.
  zed-industries/zed `v1.25.3`, `crates/paths/src/paths.rs`. The settings file Zed
  writes first starts with comments: `assets/settings/initial_user_settings.json`
- **Name and protocol**, source: `Zed`, asking for 2025-11-25 and accepting back to
  2024-11-05. `crates/context_server/src/context_server.rs` and `types.rs`
- **Timeouts**, source: 60 s per request, or the entry's `timeout` in seconds, on a
  timer progress does not reset. `crates/context_server/src/client.rs`

## Gemini CLI

- **Config**, official: `~/.gemini/settings.json`, or `.gemini/settings.json` in a
  project, `mcpServers` with `command`, `args`, `env`, `cwd`, `timeout` and `trust`;
  `gemini mcp add`. google-gemini/gemini-cli `v0.65.0`, `docs/tools/mcp-server.md`
- **Name, capabilities and timeouts**, source: `gemini-cli-mcp-client`, declaring roots
  and no elicitation; 10 minutes per request unless the entry sets `timeout` in
  milliseconds, and progress does not reset it. `packages/core/src/tools/mcp-client.ts`
- **Protocol**, source: 2025-06-18, from the MCP SDK it pins (1.23.0).

## Perplexity for Mac

- **Setup**, official: local servers work in the Mac App Store build, through the
  PerplexityXPC helper. Add one under **Plugins**, **Add custom**: a server name and
  the command that starts it.
  https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity
- Its name, protocol, timeouts and elicitation are not documented. Husk treats it as an
  app it does not know: named by what it calls itself, answered within 50 s, given
  handoff links.

## ChatGPT

- **Transport**, official: "Supported MCP protocols: SSE and streaming HTTP"
  (https://developers.openai.com/api/docs/guides/custom-mcp-server). Remote only; a
  Secure MCP Tunnel can reach a local stdio server
  (https://developers.openai.com/plugins/deploy/connect-chatgpt).
- **Session scoping**: not applicable to a local process; see `Mcp-Session-Id` above.
- **MCP Apps**, official: ChatGPT "implements the open MCP Apps standard".
  https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt
- **Elicitation**: not documented. OpenAI's server guide recommends it but does not say
  ChatGPT shows it. https://developers.openai.com/plugins/build/mcp-server
- **Prompts**: not documented.
- **`list_changed`**: no, as far as the docs show; they say to select **Refresh** after
  changing tools. https://developers.openai.com/plugins/deploy/connect-chatgpt

## The protocol itself

- Elicitation, 2025-11-25: `elicitation: {}` means form mode only. Form mode must not
  ask for sensitive data, and URL-mode links must not carry credentials or be
  pre-authenticated.
  https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- MCP Apps: tools point at a `ui://` resource with `mimeType`
  `text/html;profile=mcp-app`, rendered in a sandboxed iframe.
  https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
