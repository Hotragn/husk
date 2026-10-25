#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { HuskMcpServer } from './server.js';
import type { ComputerSpec, Flavor } from '@husk-ai/core';

/**
 * `npx -y @husk-ai/mcp`
 *
 * The whole onboarding for Claude Code, Cursor, Zed, and anything else that
 * speaks MCP. It must start fast, print nothing to stdout, and never require
 * configuration to be useful.
 */

const HELP = `husk mcp -- give your agent a Linux computer, over MCP

usage
  npx -y @husk-ai/mcp [options]

options
  --profile <name>    starter (saved workspaces) | computer (all tools; default)
  --session <key>     reuse a named machine (default: unique to this server process)
  --provider <name>   docker | podman | local | ssh | fly  (default: best available)
  --flavor <name>     base | python | node | full          (default: full, which runs the browser)
  --network <mode>    none | egress | full                 (default: full, minus internal addresses)
  --network-strict    refuse a provider that cannot enforce --network for every process
  --memory <mb>       memory ceiling
  --cpus <n>          cpu ceiling
  --keep              leave the machine running after the client disconnects
  --daemon            run the shared Husk that every chat's tools go through
                      (started for you on the first tool call; HUSK_DAEMON=off
                      keeps tools in each chat's own process)
  -h, --help

install into claude code
  claude mcp add husk -- npx -y @husk-ai/mcp

Logs go to stderr; stdout is the MCP protocol.
`;

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        session: { type: 'string' },
        profile: { type: 'string', default: 'computer' },
        provider: { type: 'string' },
        flavor: { type: 'string' },
        network: { type: 'string' },
        'network-strict': { type: 'boolean', default: false },
        memory: { type: 'string' },
        cpus: { type: 'string' },
        keep: { type: 'boolean', default: false },
        daemon: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }

  const { values } = parsed;
  if (values.help) {
    process.stderr.write(HELP);
    process.exit(0);
  }

  if (values.daemon) {
    await runDaemon();
    return;
  }

  const spec: ComputerSpec = {};
  if (values.profile !== 'starter' && values.profile !== 'computer') throw new Error('--profile must be starter or computer');
  if (values.provider) spec.provider = values.provider;
  // Every chat is offered the browser tools, and only `full` runs the browser
  // (images.ts). Providers without flavours (local, ssh) ignore it.
  spec.flavor = (values.flavor ?? 'full') as Flavor;
  if (values.network) {
    spec.network = { mode: values.network as 'none' | 'egress' | 'full', ...(values['network-strict'] ? { strict: true } : {}) };
  }
  if (values.memory) spec.memoryMb = Number(values.memory);
  if (values.cpus) spec.cpus = Number(values.cpus);

  const server = new HuskMcpServer({
    profile: values.profile,
    ...(values.session ? { sessionKey: values.session } : {}),
    spec,
    ephemeral: !values.keep,
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    process.stderr.write(`husk mcp: ${signal}, shutting down\n`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // The client going away closes stdin; without this the process lingers forever
  // holding a container open.
  process.stdin.on('close', () => void shutdown('stdin closed'));

  await server.connectStdio();
}

/**
 * The shared control plane, started detached by the first chat that needs it.
 * A second one losing the race for the port is the expected outcome, not an
 * error: the first is already serving.
 */
async function runDaemon(): Promise<void> {
  const [{ serve }, { runTool }, { DEFAULT_CONFIG }] = await Promise.all([
    import('@husk-ai/server'),
    import('./tools.js'),
    import('@husk-ai/core'),
  ]);
  // Two chats starting at once both launch one. The loser leaves before it
  // starts anything -- no triggers, no reaper -- rather than after a failed bind.
  const port = Number(process.env.HUSK_PORT) || DEFAULT_CONFIG.port;
  const answering = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).then(
    (r) => r.ok,
    () => false,
  );
  if (answering) {
    process.stderr.write('husk daemon: a Husk already answers on the port; exiting\n');
    process.exit(0);
  }
  try {
    // Nobody configures a Husk a chat started in the background, so it mints its own token.
    await serve({ daemon: true, mintToken: true, deps: { runTool } });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      process.stderr.write('husk daemon: the port is taken, so another Husk is already serving; exiting\n');
      process.exit(0);
    }
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`husk mcp failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
