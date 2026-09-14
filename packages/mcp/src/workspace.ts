import { HUSK_PORT_DEFAULT } from '@husk/core';

/**
 * Telling the agent — and through it, the human — where to *look* at the machine.
 *
 * The MCP path is the main way Husk gets used: the client already has a model,
 * so all Husk supplies is the computer. But a computer you cannot see is a
 * black box. The console's Terminal, Files and Browser panels are views of the
 * very machine these tools are driving, and until this module existed nothing
 * on the MCP path mentioned that they were there at all.
 *
 * Deliberately passive: we never start a server from inside an MCP process. An
 * MCP server is a child of someone's editor and has no business spawning a
 * listener they did not ask for. So we look, and either hand over a live link
 * or the one command that creates one.
 */

export interface WorkspaceLink {
  /** True when something is already answering on the control-plane port. */
  live: boolean;
  /** Deep link to this computer in the console, when a server is up. */
  url?: string;
  /** What to tell the user when it is not. */
  hint: string;
}

function baseUrl(): string {
  const port = process.env.HUSK_PORT ? Number(process.env.HUSK_PORT) : HUSK_PORT_DEFAULT;
  const host = process.env.HUSK_HOST ?? '127.0.0.1';
  return `http://${host}:${Number.isFinite(port) ? port : HUSK_PORT_DEFAULT}`;
}

/**
 * Is a husk control plane already listening?
 *
 * Short timeout on purpose: this runs inside a tool call, and a human waiting
 * on `computer_info` should not pay for a probe of something that is usually
 * not there.
 */
export async function findWorkspace(computerId: string, timeoutMs = 600): Promise<WorkspaceLink> {
  const base = baseUrl();
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const body = (await res.json()) as { ok?: boolean };
      if (body?.ok) {
        return {
          live: true,
          url: `${base}/#/terminal?computer=${encodeURIComponent(computerId)}`,
          hint: `Open ${base} to watch this machine: a terminal, a file browser and a web browser, all pointed at it.`,
        };
      }
    }
  } catch {
    // Not running, wrong thing on the port, or too slow. All the same answer.
  }
  return {
    live: false,
    hint:
      'To see this machine in a browser -- terminal, files and a web browser, all views of ' +
      'the same computer -- run `husk serve` in another terminal and open ' +
      `${base}. Husk needs no account and sends nothing anywhere.`,
  };
}

/** One line to append to a tool result, or empty when there is nothing useful to say. */
export async function workspaceNote(computerId: string): Promise<string> {
  const link = await findWorkspace(computerId);
  return link.live ? `\nworkspace  ${link.url}` : `\nworkspace  not running -- \`husk serve\` to watch this machine`;
}
