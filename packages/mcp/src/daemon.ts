import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUSK_VERSION, ensurePaths, readDaemonRecord } from '@husk-ai/core';
import type { DaemonRecord, Logger } from '@husk-ai/core';
import type { ToolResult } from './tools.js';

/** The daemon could not be reached at all, so nothing ran there and running locally is safe. */
export class DaemonUnreachable extends Error {}

export interface DaemonClient {
  url: string;
  callTool(computerId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export interface ConnectOptions {
  log: Logger;
  /** Start one when none answers. Default true. */
  start?: boolean;
  /** How long to wait for a daemon this process started. */
  waitMs?: number;
  /** Injected in tests. */
  read?: () => DaemonRecord | undefined;
  launch?: () => void;
  fetchImpl?: typeof fetch;
}

/**
 * Find the machine's one Husk, starting it if nobody has.
 *
 * Returns undefined -- and the caller runs tools in its own process, as every
 * release before this one did -- when `HUSK_DAEMON=off`, when a daemon of a
 * different version holds the record (its tool code may not match ours), or
 * when one cannot be started. A chat must never lose its computer because the
 * shared one is unavailable.
 */
export async function connectDaemon(opts: ConnectOptions): Promise<DaemonClient | undefined> {
  if (process.env.HUSK_DAEMON === 'off') return undefined;
  const read = opts.read ?? readDaemonRecord;
  const doFetch = opts.fetchImpl ?? fetch;

  const live = async (): Promise<DaemonRecord | undefined> => {
    const rec = read();
    if (!rec) return undefined;
    try {
      const res = await doFetch(`${rec.url}/health`, { signal: AbortSignal.timeout(1500) });
      const body = (await res.json()) as { version?: string };
      return res.ok && body.version === rec.version ? rec : undefined;
    } catch {
      return undefined;
    }
  };

  let rec = await live();
  if (!rec && opts.start !== false) {
    (opts.launch ?? launchDaemon)();
    const deadline = Date.now() + (opts.waitMs ?? 20_000);
    while (!rec && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      rec = await live();
    }
  }
  if (!rec) {
    opts.log.info('no shared husk is running; tools run in this process, and the console will not see this chat');
    return undefined;
  }
  if (rec.version !== HUSK_VERSION) {
    opts.log.info(`the shared husk is ${rec.version}, this is ${HUSK_VERSION}; tools run in this process until it restarts`);
    return undefined;
  }
  opts.log.info(`using the shared husk at ${rec.url}`);
  return client(rec, doFetch);
}

function client(rec: DaemonRecord, doFetch: typeof fetch): DaemonClient {
  return {
    url: rec.url,
    async callTool(computerId, name, args, signal) {
      let res: Response;
      try {
        res = await doFetch(`${rec.url}/v1/computers/${encodeURIComponent(computerId)}/tools/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(rec.token ? { authorization: `Bearer ${rec.token}` } : {}) },
          body: JSON.stringify({ args, via: 'mcp' }),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        // Refused before anything was sent: nothing ran, so the caller may run it here.
        // Anything else (a reset mid-call, an abort) may have run, and is not retried.
        const code = (err as { cause?: { code?: string } }).cause?.code;
        if (code === 'ECONNREFUSED') throw new DaemonUnreachable(`the shared husk at ${rec.url} refused the connection`);
        throw err;
      }
      const body = (await res.json().catch(() => ({}))) as ToolResult & { error?: { message?: string; hint?: string } };
      if (res.ok && Array.isArray(body.content)) return body;
      const message = body.error?.message ?? `the shared husk answered ${res.status}`;
      return { isError: true, content: [{ type: 'text', text: body.error?.hint ? `${message}\n${body.error.hint}` : message }] };
    },
  };
}

/**
 * Start `husk-mcp --daemon` detached, so it outlives this chat. Its output goes
 * to ~/.husk/daemon.log, since nobody is watching its terminal.
 */
function launchDaemon(): void {
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  const logPath = join(ensurePaths().root, 'daemon.log');
  const fd = openSync(logPath, 'a', 0o600);
  try {
    spawn(process.execPath, [bin, '--daemon'], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true }).unref();
  } finally {
    closeSync(fd);
  }
}
