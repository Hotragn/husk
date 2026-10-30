import { DEFAULT_CONFIG, HuskError } from '@husk-ai/core';
import { parse, parseCount } from '../args.js';
import { orientBriefly } from '../lib/first-run.js';
import { interruptSignal } from '../signal.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/**
 * Start the control plane.
 *
 * `@husk-ai/server` is imported lazily -- it pulls Fastify, and a CLI that paid for
 * a web framework on `husk --help` would be a slow CLI.
 */
interface RunningServer {
  url: string;
  host: string;
  port: number;
  claimCode?: string;
  remotePort?: number;
  warnings?: string[];
  close(): Promise<void>;
}

interface ServerModule {
  serve(opts: {
    host: string;
    port: number;
    daemon?: boolean;
    deps?: { runTool?: unknown; remoteMcp?: unknown };
    remote?: { publicUrl: string; provider: string; port?: number; host?: string };
  }): Promise<RunningServer>;
  parsePublicUrl(raw: string): URL;
}

/** Where to listen: the flags, then HUSK_HOST and HUSK_PORT, as a service's unit file sets them, then the defaults. */
export function listenOn(values: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const flag = values.port as string | undefined;
  const port = parseCount(flag ?? (env.HUSK_PORT || undefined), flag === undefined ? 'HUSK_PORT' : '--port', 'serve') ?? DEFAULT_CONFIG.port;
  return { host: (values.host as string | undefined) ?? (env.HUSK_HOST || DEFAULT_CONFIG.host), port };
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(
    argv,
    {
      port: { type: 'string' },
      host: { type: 'string' },
      remote: { type: 'boolean' },
      'public-url': { type: 'string' },
      provider: { type: 'string' },
      'remote-port': { type: 'string' },
      'remote-host': { type: 'string' },
    },
    'serve',
  );
  ui.configure(values);
  orientBriefly('open the console it prints, or POST /v1/husks/<name>/run');

  const { host, port } = listenOn(values);
  const publicUrl = values['public-url'] as string | undefined;
  if ((values.remote === true) !== Boolean(publicUrl)) {
    throw new HuskError('E_CONFIG', '--remote and --public-url go together: the public URL is the fixed https name your tunnel gives this port', {
      hint: 'for example: husk serve --remote --public-url https://box.tail1234.ts.net',
    });
  }
  const provider = (values.provider as string | undefined) ?? 'docker';
  const remotePort = parseCount(values['remote-port'] as string | undefined, '--remote-port', 'serve');
  const remoteHost = values['remote-host'] as string | undefined;
  if ((remotePort !== undefined || remoteHost !== undefined) && values.remote !== true) {
    throw new HuskError('E_CONFIG', '--remote-port and --remote-host are for remote access', { hint: 'add --remote --public-url https://<name>' });
  }

  let mod: ServerModule;
  try {
    mod = (await import('@husk-ai/server')) as ServerModule;
  } catch (err) {
    throw new HuskError('E_NOT_IMPLEMENTED', `could not load @husk-ai/server: ${(err as Error).message}`, {
      hint: 'run `npm install && npm run build` at the repo root',
      cause: err,
    });
  }

  const spin = ui.spinner(`starting the control plane on ${host}:${port}`);

  let server: RunningServer;
  try {
    // The machine's one Husk: chats' MCP processes find it through
    // ~/.husk/daemon.json and run their computer tools here, so the console
    // sees every chat as well as every husk run.
    const { runTool } = await import('@husk-ai/mcp/tools');
    if (values.remote === true && publicUrl) {
      mod.parsePublicUrl(publicUrl);
      const { createRemoteMcp } = await import('@husk-ai/mcp/remote');
      server = await mod.serve({
        host,
        port,
        daemon: true,
        deps: { runTool, remoteMcp: createRemoteMcp({ provider }) },
        remote: { publicUrl, provider, ...(remotePort !== undefined ? { port: remotePort } : {}), ...(remoteHost ? { host: remoteHost } : {}) },
      });
    } else {
      server = await mod.serve({ host, port, daemon: true, deps: { runTool } });
    }
  } catch (err) {
    spin.stop();
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw await describePortHolder(host, port, err);
    }
    throw err;
  } finally {
    spin.stop();
  }

  if (host !== DEFAULT_CONFIG.host) {
    ui.warn(`bound to ${host}, not loopback — anything that can reach this port can drive your computers`);
  }

  ui.print(`${ui.green('✓')} control plane on ${ui.bold(server.url)}`);
  // Never the token itself: terminals keep scrollback and logs get shared.
  const signIn = process.env.HUSK_TOKEN ? '  (sign in with your HUSK_TOKEN)' : values.remote === true ? '  (its token is in ~/.husk/daemon.json, readable only by you)' : '';
  ui.print(`  console  ${server.url}/${signIn ? ui.dim(signIn) : ''}`);
  ui.print(ui.dim(`  health   ${server.url}/health`));
  ui.print(ui.dim(`  doctor   ${server.url}/v1/doctor`));
  ui.print(ui.dim(`  clients  new HuskClient({ baseUrl: "${server.url}" })  // @husk-ai/sdk`));
  if (publicUrl && values.remote === true) {
    const origin = new URL(publicUrl).origin;
    const published = server.remotePort ?? port + 1;
    ui.print('');
    ui.print(`${ui.green('✓')} remote access on ${ui.bold(`${origin}/mcp`)}, for its owner only, on ${provider} computers`);
    // Its own port, never the console's: the tunnel reaches remote access and nothing else.
    ui.print(`  publish port ${published} at that name with your tunnel, e.g. ${ui.cyan(`tailscale funnel --bg ${published}`)}`);
    ui.print(`  then add ${origin}/mcp to your chat app as a custom connector, and sign in when it asks`);
    for (const w of server.warnings ?? []) ui.warn(w);
    // Shown on a terminal, never written to a log: whoever types it first becomes the owner,
    // and a service's output (systemd, a container, Fly) is a log someone else may read.
    if (server.claimCode && process.stdout.isTTY) {
      ui.print(`  claim code ${ui.bold(server.claimCode)}  ${ui.dim('good for 15 minutes; `husk remote claim` makes a new one')}`);
    } else if (server.claimCode) {
      ui.print('  no owner yet: run `husk remote claim` on this machine for a claim code (it is not written here, which may be a log)');
    }
  }
  ui.note('');
  ui.note(ui.dim('Ctrl-C to stop.'));

  await new Promise<void>((resolveWait) => {
    interruptSignal().addEventListener('abort', () => resolveWait(), { once: true });
  });

  // Close cleanly so in-flight runs are cancelled and the reaper stops, rather
  // than letting process exit strand a half-written run log.
  await server.close().catch(() => {});
  ui.note(ui.dim('stopped'));
  return EXIT_OK;
}

/**
 * Say *what* is on the port, not just that something is.
 *
 * An older husk holding the port is the case that actually happens, and it is
 * the one a generic "address in use" hides worst: the port keeps answering, so
 * everything looks healthy while requests go to a build that predates whatever
 * you just changed. It cost me two long debugging detours -- routes returning
 * 404 that plainly existed in `dist`, assets 404ing that were plainly on disk.
 *
 * So: ask the port who it is, and if it is a husk, print its version and how
 * long it has been there.
 */
async function describePortHolder(host: string, port: number, cause: unknown): Promise<HuskError> {
  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { ok?: boolean; version?: string; uptimeSec?: number };
    if (body?.ok) {
      const age = body.uptimeSec === undefined ? 'unknown age' : humaniseUptime(body.uptimeSec);
      return new HuskError('E_CONFIG', `another husk server (v${body.version ?? '?'}) is already on ${host}:${port}`, {
        hint:
          `it has been running for ${age}, so it may predate your latest build. ` +
          'Stop that process and start again, or pass --port for a second one.',
        cause,
      });
    }
  } catch {
    // Not a husk, or not answering. Fall through to the generic message.
  }
  return new HuskError('E_CONFIG', `port ${port} on ${host} is already in use by something else`, {
    hint: 'pass --port with a free one, or stop whatever is holding it',
    cause,
  });
}

function humaniseUptime(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}
