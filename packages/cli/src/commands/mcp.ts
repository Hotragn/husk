import { HuskError } from '@husk-ai/core';
import { parse } from '../args.js';
import * as ui from '../ui.js';
import { EXIT_OK } from '../exit.js';

/**
 * The MCP server on stdio.
 *
 * stdout is the JSON-RPC channel. Nothing human-readable may touch it, ever -- a
 * single stray line is a parse error on the client and surfaces as "husk is
 * broken" inside someone's editor. So `--json` and `--quiet` are deliberately
 * overridden here: there is no human reading stdout, and every note goes to
 * stderr where an MCP client collects logs.
 */
interface McpModule {
  HuskMcpServer?: new (opts?: {
    sessionKey?: string;
    ephemeral?: boolean;
    spec?: { provider?: string };
  }) => { connectStdio(): Promise<void>; close(): Promise<void> };
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(
    argv,
    {
      provider: { type: 'string' },
      'session-key': { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
    'mcp',
  );
  ui.configure({ ...values, json: false, quiet: false });

  let mod: McpModule;
  try {
    mod = (await import('@husk-ai/mcp')) as McpModule;
  } catch (err) {
    throw new HuskError('E_NOT_IMPLEMENTED', `could not load @husk-ai/mcp: ${(err as Error).message}`, {
      hint: 'run `npm install && npm run build` at the repo root',
      cause: err,
    });
  }

  if (typeof mod.HuskMcpServer !== 'function') {
    throw new HuskError('E_NOT_IMPLEMENTED', '@husk-ai/mcp exports no stdio server', {
      hint: 'expected HuskMcpServer — the CLI is ready to call it the moment it lands',
    });
  }

  const server = new mod.HuskMcpServer({
    ...(values['session-key'] ? { sessionKey: values['session-key'] as string } : {}),
    // `--keep` leaves the machine alive after the client disconnects, which is
    // what you want while debugging and not what you want by default.
    ephemeral: values.keep !== true,
    ...(values.provider ? { spec: { provider: values.provider as string } } : {}),
  });

  ui.note(ui.dim('husk mcp — speaking MCP on stdio. Logs are on stderr; stdout is the protocol.'));

  await server.connectStdio();

  // The transport owns the process from here. Resolve when stdin closes, which
  // is how an MCP client says it is finished with us.
  await new Promise<void>((done) => {
    process.stdin.on('end', done);
    process.stdin.on('close', done);
  });

  await server.close().catch(() => {});
  return EXIT_OK;
}
