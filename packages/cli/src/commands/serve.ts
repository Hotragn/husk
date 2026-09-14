import { DEFAULT_CONFIG, HuskError } from '@husk-ai/core';
import { parse, parseCount } from '../args.js';
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
  close(): Promise<void>;
}

interface ServerModule {
  serve(opts: { host: string; port: number }): Promise<RunningServer>;
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { port: { type: 'string' }, host: { type: 'string' } }, 'serve');
  ui.configure(values);

  const port = parseCount(values.port as string | undefined, '--port', 'serve') ?? DEFAULT_CONFIG.port;
  const host = (values.host as string | undefined) ?? DEFAULT_CONFIG.host;

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
    server = await mod.serve({ host, port });
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
  ui.print(ui.dim(`  health   ${server.url}/health`));
  ui.print(ui.dim(`  doctor   ${server.url}/v1/doctor`));
  ui.print(ui.dim(`  clients  new HuskClient({ baseUrl: "${server.url}" })  // @husk-ai/sdk`));
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
