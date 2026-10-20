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

/**
 * A display name for an MCP client from its self-reported `clientInfo.name`.
 *
 * That name is the client's own text, so it is cut to a short run of plain
 * characters before it is stored or shown. Known names map to the product name;
 * `claude-ai` is Claude Desktop here because Husk's MCP server speaks stdio,
 * which only the desktop app runs.
 */
export function platformName(clientName: string | undefined): string {
  const raw = (clientName ?? '').trim();
  const known: Array<[RegExp, string]> = [
    [/^claude-code$/i, 'Claude Code'],
    [/^claude-ai$/i, 'Claude Desktop'],
    [/^cursor/i, 'Cursor'],
    [/^(visual studio code|vscode)/i, 'VS Code'],
    [/^windsurf/i, 'Windsurf'],
    [/^zed/i, 'Zed'],
  ];
  for (const [re, name] of known) if (re.test(raw)) return name;
  const clean = raw.replace(/[^\w .()-]/g, '').trim().slice(0, 40);
  return clean || 'MCP client';
}

/** "Claude Desktop · chat started 10:42", in the machine's local time. */
export function chatLabel(platform: string, source: IdentitySource, at: Date = new Date()): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${platform} · ${source === 'first-call' ? 'chat' : 'session'} started ${hh}:${mm}`;
}
