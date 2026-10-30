import { redact } from '@husk-ai/core';

/** One tool call on a computer, as the console's activity timeline shows it. */
export interface ActivityEntry {
  at: string;
  tool: string;
  ok: boolean;
  ms: number;
  /** Who made the call: `mcp` for a chat, `agent` for a husk run. */
  via: string;
  /** A short, redacted look at the target: the command, path or URL. Never typed text. */
  summary?: string;
}

/**
 * Which argument is worth showing for each tool. An allowlist, not a denylist:
 * `browser_type` carries what a person or model typed into a page, which can be
 * a password, so a tool that is not listed here shows its name and nothing else.
 */
const SUMMARY_ARG: Record<string, string> = {
  shell: 'command',
  read_file: 'path',
  write_file: 'path',
  edit_file: 'path',
  list_dir: 'path',
  expose_port: 'port',
  browse: 'url',
  browser_goto: 'url',
  browser_navigate: 'how',
  browser_click: 'ref',
  browser_hover: 'ref',
  browser_upload: 'ref',
};

export function summarise(tool: string, args: Record<string, unknown>): string | undefined {
  const key = SUMMARY_ARG[tool];
  const value = key ? args[key] : undefined;
  if (value === undefined || value === null || value === '') return undefined;
  const text = redact(String(value)).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** The last few hundred tool calls per computer, in memory. A restart starts a fresh timeline. */
export class ActivityLog {
  private readonly byComputer = new Map<string, ActivityEntry[]>();

  constructor(private readonly limit = 200) {}

  record(computerId: string, entry: ActivityEntry): void {
    const list = this.byComputer.get(computerId) ?? [];
    list.push(entry);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
    this.byComputer.set(computerId, list);
  }

  list(computerId: string): ActivityEntry[] {
    return [...(this.byComputer.get(computerId) ?? [])];
  }

  latest(computerId: string): ActivityEntry | undefined {
    return this.byComputer.get(computerId)?.at(-1);
  }

  forget(computerId: string): void {
    this.byComputer.delete(computerId);
  }
}
