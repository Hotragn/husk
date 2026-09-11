import { DEFAULT_CONFIG, HuskError } from '@husk/core';
import { parse, parseCount } from '../args.js';
import { interruptSignal } from '../signal.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/**
 * Start the control plane.
 *
 * `@husk/server` is imported lazily -- it pulls Fastify, and a CLI that paid for
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
    mod = (await import('@husk/server')) as ServerModule;
  } catch (err) {
    throw new HuskError('E_NOT_IMPLEMENTED', `could not load @husk/server: ${(err as Error).message}`, {
      hint: 'run `npm install && npm run build` at the repo root',
      cause: err,
    });
  }

  const spin = ui.spinner(`starting the control plane on ${host}:${port}`);

  let server: RunningServer;
  try {
    server = await mod.serve({ host, port });
  } finally {
    spin.stop();
  }

  if (host !== DEFAULT_CONFIG.host) {
    ui.warn(`bound to ${host}, not loopback — anything that can reach this port can drive your computers`);
  }

  ui.print(`${ui.green('✓')} control plane on ${ui.bold(server.url)}`);
  ui.print(ui.dim(`  health   ${server.url}/health`));
  ui.print(ui.dim(`  doctor   ${server.url}/v1/doctor`));
  ui.print(ui.dim(`  mcp      ${server.url}/mcp  (streamable http — point a chat client here)`));
  ui.print(ui.dim(`  clients  new HuskClient({ baseUrl: "${server.url}" })  // @husk/sdk`));
  ui.note('');

  // The MCP URL is only useful to a hosted chat surface if that surface can
  // reach it, and a loopback bind means it cannot. Saying so here is cheaper
  // than letting someone paste a localhost URL into ChatGPT and debug the
  // timeout.
  if (!process.env.HUSK_TOKEN) {
    ui.note(ui.dim('  no HUSK_TOKEN — loopback clients only. A hosted chat surface needs a token and a'));
    ui.note(ui.dim('  reachable address; see the MCP section of docs/API.md.'));
  }
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
