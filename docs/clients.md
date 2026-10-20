# MCP clients: what each one supports

What Husk can rely on in each chat app, and where that comes from. **Official** means
the app's or the protocol's own current docs. **Community** means a forum post, issue
or blog, and is a lead, not a fact. "Not documented" means we looked and found nothing.
Checked October 2026; re-check before depending on a cell.

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
- **In-chat "I'm done".** Offered only to clients whose name matches `SHOWS_ELICITATION`
  in `packages/mcp/src/server.ts`; everyone else gets the handoff link to relay.
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
