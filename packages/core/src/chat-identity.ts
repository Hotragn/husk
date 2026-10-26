/**
 * Which app made a computer, and how Husk told that app's chats apart.
 *
 * Built only from signals the platforms provide on purpose: the MCP client's
 * own name, a session id the host hands its server process, or the computer id
 * the chat itself carries forward. Never from chat titles or chat content.
 */

/**
 * - `session`: the host gave this server process a session id (Claude Code sets
 *   CLAUDE_CODE_SESSION_ID: https://code.claude.com/docs/en/env-vars), so one
 *   process is one chat.
 * - `named`: the user named the session (`--session`, HUSK_SESSION).
 * - `first-call`: no signal from the host. The chat's first Husk call made the
 *   computer and the chat passes its id back on every later call.
 */
export type IdentitySource = 'session' | 'named' | 'first-call';

export const IDENTITY_LABELS = {
  platform: 'husk.platform',
  chat: 'husk.chat',
  identity: 'husk.identity',
} as const;

export interface ChatIdentity {
  /** "Claude Desktop", "Cursor", "Claude Code", ... */
  platform?: string;
  /** "Claude Desktop · chat started 10:42". */
  chatLabel?: string;
  identitySource?: IdentitySource;
}

const SOURCES: readonly string[] = ['session', 'named', 'first-call'];

export function chatIdentityOf(labels: Record<string, string> | undefined): ChatIdentity {
  const out: ChatIdentity = {};
  const platform = labels?.[IDENTITY_LABELS.platform];
  const chat = labels?.[IDENTITY_LABELS.chat];
  const source = labels?.[IDENTITY_LABELS.identity];
  if (platform) out.platform = platform;
  if (chat) out.chatLabel = chat;
  if (source && SOURCES.includes(source)) out.identitySource = source as IdentitySource;
  return out;
}

/** What Husk knows of a chat app, from the name it gives itself. */
export interface ChatClient {
  /** The product's name: "Claude Desktop", "Cursor", ... */
  name: string;
  /**
   * How long Husk holds a tool call open before it answers that the call is
   * still running, so the chat collects it with `job_wait` instead of the app
   * giving up on it. Under the app's own limit on a call; none where the app
   * waits as long as a call takes.
   */
  waitSec?: number;
  /** The app shows a form elicitation, so a handoff asks "Done?" in the chat. */
  asksInChat: boolean;
}

/**
 * Each app's facts, by the start of its `clientInfo.name`. docs/clients.md has
 * the sources. A wrong `asksInChat` costs the in-chat prompt, never safety; a
 * wrong `waitSec` costs a timeout, so where an app's limit is unknown or
 * differs between its versions, Husk takes the shortest.
 */
const CLIENTS: Array<{ match: RegExp } & ChatClient> = [
  // A stdio call quiet for 30 minutes is ended (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).
  { match: /^claude-code$/i, name: 'Claude Code', waitSec: 1500, asksInChat: true },
  // `claude-ai` is Claude Desktop here: Husk's MCP server speaks stdio, which only
  // the desktop app runs. 240 s for a whole call, progress or not.
  { match: /^claude-(ai|desktop)$/i, name: 'Claude Desktop', waitSec: 220, asksInChat: false },
  // The desktop app's Code tab, on the MCP SDK's 60 s.
  { match: /^local-agent-mode-/i, name: 'Claude Desktop', waitSec: 50, asksInChat: false },
  // 300 s since mid-2026; 60 s before, which its docs still say.
  { match: /^codex/i, name: 'Codex', waitSec: 50, asksInChat: false },
  // About an hour in the editor, 60 s in its CLI, which Husk cannot tell apart.
  { match: /^cursor/i, name: 'Cursor', waitSec: 50, asksInChat: true },
  { match: /^(visual studio code|vscode)/i, name: 'VS Code', asksInChat: true },
  { match: /^windsurf/i, name: 'Windsurf', waitSec: 50, asksInChat: false },
  // 60 s, unless the person's entry sets its own `timeout`.
  { match: /^zed/i, name: 'Zed', waitSec: 50, asksInChat: false },
  { match: /^gemini-cli/i, name: 'Gemini CLI', waitSec: 540, asksInChat: false },
];

/**
 * A chat app from its self-reported `clientInfo.name`. That name is the
 * client's own text, so an app Husk does not know is named by a short run of
 * its plain characters, and gets the MCP SDK's default 60 s as its limit.
 */
export function chatClient(clientName: string | undefined): ChatClient {
  const raw = (clientName ?? '').trim();
  const known = CLIENTS.find((c) => c.match.test(raw));
  if (known) return { name: known.name, ...(known.waitSec ? { waitSec: known.waitSec } : {}), asksInChat: known.asksInChat };
  const clean = raw.replace(/[^\w .()-]/g, '').trim().slice(0, 40);
  return { name: clean || 'MCP client', waitSec: 50, asksInChat: false };
}

/** A display name for an MCP client, from its self-reported `clientInfo.name`. */
export function platformName(clientName: string | undefined): string {
  return chatClient(clientName).name;
}

/** "Claude Desktop · chat started 10:42", in the machine's local time. */
export function chatLabel(platform: string, source: IdentitySource, at: Date = new Date()): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${platform} · ${source === 'first-call' ? 'chat' : 'session'} started ${hh}:${mm}`;
}
