/**
 * How each MCP client actually installs Husk.
 *
 * Every entry below was read off that client's own current documentation on
 * 2026-09-17, not from memory and not from another client that looked similar.
 * The `source` field is the page it came from; the date is in `VERIFIED_ON`.
 * A wrong install line here does not degrade gracefully — it breaks the first
 * thing a new reader tries, which is worse than not offering the button.
 *
 * Three things this check actually caught, all of which a reasonable person
 * would have got wrong by pattern-matching:
 *
 *   - Antigravity's config is `~/.gemini/config/mcp_config.json`. A number of
 *     write-ups say `~/.gemini/antigravity/mcp_config.json`; Google's own MCP
 *     pages, both the IDE one and the CLI one, say `config`.
 *   - Zed does not use `mcpServers`. Its key is `context_servers`, and the
 *     example in its docs carries an `env` object.
 *   - Cursor's deeplink base64-encodes the *inner* server object only, not the
 *     `{"mcpServers": {...}}` wrapper. The encoder in this file reproduces the
 *     worked example in Cursor's docs byte for byte, which is how that is
 *     known rather than assumed.
 *
 * Gemini CLI is deliberately absent. It was retired for free, Pro and Ultra
 * users in favour of Antigravity, so a panel for it would point most readers
 * at a dead product.
 */

import { MCP_COMMAND, REPO_URL } from "@/lib/content";

export const VERIFIED_ON = "2026-09-17";

/** The one server definition every client below is some encoding of. */
const SERVER = { command: "npx", args: ["-y", "@husk-ai/mcp"] } as const;

const json = (o: unknown) => JSON.stringify(o, null, 2);

/**
 * Cursor's one-click link.
 *
 * `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64`,
 * where the base64 is `JSON.stringify` of the server's own transport config —
 * no wrapper, no name key. Built at module scope so it cannot drift from
 * `SERVER`.
 */
function cursorDeeplink(): string {
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(JSON.stringify(SERVER), "utf8").toString("base64")
      : btoa(JSON.stringify(SERVER));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=husk&config=${encodeURIComponent(b64)}`;
}

export type ClientPanel =
  | { kind: "cli"; command: string }
  | {
      kind: "config";
      path: string;
      altPath?: string;
      /* What the alternative path is FOR. Cursor's second path is the global
         one and Antigravity's is the per-workspace one -- opposite meanings,
         so the sentence cannot be hardcoded in the component. */
      altScope?: string;
      snippet: string;
      deeplink?: string;
    }
  | { kind: "link"; href: string };

export interface McpClient {
  id: string;
  /** What the pill says. The company's own name for the product. */
  name: string;
  /** One line under the panel. Plain, no marketing. */
  note: string;
  /** The page this was verified against. */
  source: string;
  panel: ClientPanel;
}

export const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    note: "One command. Nothing else to edit.",
    source: "https://code.claude.com/docs/en/mcp",
    panel: { kind: "cli", command: MCP_COMMAND },
  },
  {
    id: "codex",
    name: "Codex CLI",
    note: "Same shape as Claude Code. Written to ~/.codex/config.toml for you.",
    source: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
    panel: { kind: "cli", command: "codex mcp add husk -- npx -y @husk-ai/mcp" },
  },
  {
    id: "cursor",
    name: "Cursor",
    note: "No add command in Cursor. The link fills the config in for you; the block is the same thing by hand.",
    source: "https://cursor.com/docs/context/mcp",
    panel: {
      kind: "config",
      path: ".cursor/mcp.json",
      altPath: "~/.cursor/mcp.json",
      altScope: "for every project",
      snippet: json({ mcpServers: { husk: SERVER } }),
      deeplink: cursorDeeplink(),
    },
  },
  {
    id: "zed",
    name: "Zed",
    note: "Zed calls them context servers, not MCP servers — the key is different from every other client here. Open the file from the command palette with “zed: open settings file”.",
    source: "https://zed.dev/docs/ai/mcp",
    panel: {
      kind: "config",
      /* Just the filename. Zed's own docs reach for the command-palette action
         rather than a path because the path differs across the three
         platforms; the action is in the note, where a sentence belongs, rather
         than stuffed inside a <code> element. */
      path: "settings.json",
      snippet: json({ context_servers: { husk: { ...SERVER, env: {} } } }),
    },
  },
  {
    id: "antigravity",
    name: "Antigravity",
    note: "Config file, no add command. The CLI and the IDE read the same file.",
    source: "https://antigravity.google/docs/mcp/",
    panel: {
      kind: "config",
      path: "~/.gemini/config/mcp_config.json",
      altPath: ".agents/mcp_config.json",
      altScope: "for one workspace only",
      snippet: json({ mcpServers: { husk: SERVER } }),
    },
  },
  {
    id: "other",
    name: "Anything else",
    note: "Husk speaks MCP over stdio. Any client that does will take the same two fields.",
    source: REPO_URL,
    panel: { kind: "link", href: `${REPO_URL}#readme` },
  },
];

export const DEFAULT_CLIENT = "claude-code";
