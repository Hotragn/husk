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
  --session <key>     reuse one machine across calls (default: "mcp")
  --provider <name>   docker | podman | local | ssh | fly  (default: best available)
  --flavor <name>     base | python | node | full          (default: base)
  --network <mode>    none | egress | full                 (default: egress)
  --memory <mb>       memory ceiling
  --cpus <n>          cpu ceiling
  --keep              leave the machine running after the client disconnects
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
        provider: { type: 'string' },
        flavor: { type: 'string' },
        network: { type: 'string' },
        memory: { type: 'string' },
        cpus: { type: 'string' },
        keep: { type: 'boolean', default: false },
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

  const spec: ComputerSpec = {};
  if (values.provider) spec.provider = values.provider;
  if (values.flavor) spec.flavor = values.flavor as Flavor;
  if (values.network) spec.network = { mode: values.network as 'none' | 'egress' | 'full' };
  if (values.memory) spec.memoryMb = Number(values.memory);
  if (values.cpus) spec.cpus = Number(values.cpus);

  const server = new HuskMcpServer({
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

main().catch((err) => {
  process.stderr.write(`husk mcp failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
