import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUSK_VERSION, ensurePaths, readDaemonRecord } from '@husk-ai/core';
import type { DaemonRecord, Logger } from '@husk-ai/core';
import type { ToolResult } from './tools.js';

/** The daemon could not be reached at all, so nothing ran there and running locally is safe. */
export class DaemonUnreachable extends Error {}

/**
 * The daemon is up but cannot see this chat's computer (a provider that needs
 * this chat's own environment, such as FLY_API_TOKEN). Nothing ran there, so
 * the call runs in the chat's own process instead.
 */
export class RunLocally extends Error {}

/** How a chat's handoff in the shared Husk stands. */
export type RemoteHandoffState = 'open' | 'done' | 'aborted' | 'unknown';

export interface DaemonClient {
  url: string;
  callTool(computerId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  /** Give a computer to the person in the shared console. The token opens that computer only. */
  openHandoff(computerId: string, reason: string, label?: string): Promise<{ handoffId: string; token: string }>;
  /** Whether a handoff is still waiting, or how it ended. Polling it also keeps it alive. */
  state(handoffId: string): Promise<RemoteHandoffState>;
  /** The person said done, in the chat. */
  complete(handoffId: string): Promise<void>;
  /** The chat went away before the person finished. */
  cancel(handoffId: string): Promise<void>;
  /** A short-lived token that opens one computer's page in the console. */
  linkToken(computerId: string): Promise<string>;
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
  if (rec.version !== HUSK_VERSION && newer(HUSK_VERSION, rec.version) && opts.start !== false) {
    // An older Husk after an upgrade: ask it to step aside (it refuses while a
    // run or a handoff is in progress), then start this version.
    const asked = await doFetch(`${rec.url}/v1/shutdown`, {
      method: 'POST',
      headers: rec.token ? { authorization: `Bearer ${rec.token}` } : {},
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
    if (asked?.status === 202) {
      for (let i = 0; i < 40 && (await live()); i++) await new Promise((r) => setTimeout(r, 250));
      (opts.launch ?? launchDaemon)();
      const deadline = Date.now() + (opts.waitMs ?? 20_000);
      rec = undefined;
      while (!rec && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        rec = await live();
      }
      if (!rec) return undefined;
    }
  }
  if (rec.version !== HUSK_VERSION) {
    opts.log.info(`the shared husk is ${rec.version}, this is ${HUSK_VERSION}; tools run in this process until it restarts`);
    return undefined;
  }
  opts.log.info(`using the shared husk at ${rec.url}`);
  return client(rec, doFetch, read);
}

/** a > b for x.y.z versions. */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

function client(first: DaemonRecord, doFetch: typeof fetch, read: () => DaemonRecord | undefined): DaemonClient {
  let rec = first;
  /**
   * The daemon restarted (another chat started a new one, with a new token):
   * pick up its record. True if it changed, so one retry is worth it -- a 401
   * proves nothing ran.
   */
  const reread = (): boolean => {
    const next = read();
    if (!next || next.version !== rec.version || (next.pid === rec.pid && next.token === rec.token)) return false;
    rec = next;
    return true;
  };
  const send = async (method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> => {
    const go = () =>
      doFetch(`${rec.url}${path}`, {
        method,
        headers: {
          ...(rec.token ? { authorization: `Bearer ${rec.token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ?? AbortSignal.timeout(10_000),
      });
    let res: Response;
    try {
      res = await go();
    } catch (err) {
      // Refused before anything was sent: nothing ran. Anything else (a reset
      // mid-call, an abort) may have run, and is not retried.
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code === 'ECONNREFUSED') {
        if (reread()) return send(method, path, body, signal);
        throw new DaemonUnreachable(`the shared husk at ${rec.url} refused the connection`);
      }
      throw err;
    }
    if (res.status === 401 && reread()) res = await go();
    return res;
  };
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await send(method, path, body);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 400 && res.status !== 404) {
      const err = json.error as { message?: string } | undefined;
      throw new Error(err?.message ?? `the shared husk answered ${res.status}`);
    }
    return { status: res.status, json };
  };
  const id = encodeURIComponent;
  return {
    get url() {
      return rec.url;
    },
    async openHandoff(computerId, reason, label) {
      const { status, json } = await call('POST', `/v1/computers/${id(computerId)}/handoffs`, { reason, ...(label ? { label } : {}) });
      if (status === 404) throw new RunLocally(`the shared husk has no computer ${computerId}`);
      return { handoffId: String(json.handoffId), token: String(json.token) };
    },
    async state(handoffId) {
      const { json } = await call('GET', `/v1/handoffs/${id(handoffId)}/state`);
      const s = json.state;
      return s === 'open' || s === 'done' || s === 'aborted' ? s : 'unknown';
    },
    async complete(handoffId) {
      const { status } = await call('POST', `/v1/handoffs/${id(handoffId)}/done`);
      if (status === 404) throw new Error(`the shared husk no longer has handoff ${handoffId}`);
    },
    async cancel(handoffId) {
      await call('DELETE', `/v1/handoffs/${id(handoffId)}`);
    },
    async linkToken(computerId) {
      const { status, json } = await call('POST', `/v1/computers/${id(computerId)}/link`);
      if (status === 404) throw new RunLocally(`the shared husk has no computer ${computerId}`);
      // Never a link that opens nothing: `token=undefined` reads as a working link.
      if (typeof json.token !== 'string' || !json.token) throw new Error('the shared husk gave no link token');
      return json.token;
    },
    async callTool(computerId, name, args, signal) {
      const res = await send('POST', `/v1/computers/${id(computerId)}/tools/${id(name)}`, { args, via: 'mcp' }, signal);
      const body = (await res.json().catch(() => ({}))) as ToolResult & { error?: { code?: string; message?: string; hint?: string } };
      if (res.ok && Array.isArray(body.content)) return body;
      if (res.status === 404 && body.error?.code === 'E_COMPUTER_NOT_FOUND') {
        throw new RunLocally(`the shared husk cannot see computer ${computerId}`);
      }
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
    // Inside the desktop app's Linux AppImage (run with --husk-mcp, not as
    // Node), the daemon is the AppImage again: the current mount goes away.
    const appImage = process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE ? process.env.APPIMAGE : undefined;
    const [command, args] = appImage ? [appImage, ['--husk-mcp', '--daemon']] : [process.execPath, [bin, '--daemon']];
    // From the home folder: not the chat's project, which may hold anything.
    spawn(command, args, { cwd: homedir(), detached: true, stdio: ['ignore', fd, fd], windowsHide: true }).unref();
  } finally {
    closeSync(fd);
  }
}
