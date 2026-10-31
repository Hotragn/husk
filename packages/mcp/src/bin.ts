#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { HuskMcpServer } from './server.js';
import { loadEnvFile } from '@husk-ai/core';
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
  --browser <name>    chrome | lightpanda                  (default: config.json's browser, else chrome)
  --network <mode>    none | egress | full                 (default: full, minus internal addresses)
  --network-strict    refuse a provider that cannot enforce --network for every process
  --memory <mb>       memory ceiling
  --cpus <n>          cpu ceiling
  --keep              leave the machine running after the client disconnects
  --daemon            run the shared Husk that every chat's tools go through
                      (started for you on the first tool call; HUSK_DAEMON=off
                      keeps tools in each chat's own process)
  --jobs              run the job host: bots' schedules, webhooks and chat
                      triggers (the shared Husk starts it when a bot has one)
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
        browser: { type: 'string' },
        network: { type: 'string' },
        'network-strict': { type: 'boolean', default: false },
        memory: { type: 'string' },
        cpus: { type: 'string' },
        keep: { type: 'boolean', default: false },
        daemon: { type: 'boolean', default: false },
        jobs: { type: 'boolean', default: false },
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
  // ~/.husk/.env, for the shared Husk, the job host and a chat's own process
  // alike. The environment the chat app started this with wins over the file.
  loadEnvFile();

  if (values.daemon) {
    await runDaemon();
    return;
  }
  if (values.jobs) {
    await runJobs();
    return;
  }

  const spec: ComputerSpec = {};
  if (values.profile !== 'starter' && values.profile !== 'computer') throw new Error('--profile must be starter or computer');
  if (values.provider) spec.provider = values.provider;
  // Every chat is offered the browser tools, and only `full` runs the browser
  // (images.ts). Providers without flavours (local, ssh) ignore it.
  spec.flavor = (values.flavor ?? 'full') as Flavor;
  if (values.browser) {
    if (values.browser !== 'chrome' && values.browser !== 'lightpanda') throw new Error('--browser must be chrome or lightpanda');
    spec.browser = values.browser;
  }
  // Strict refuses a provider that cannot hold every process to a mode. With no
  // --network there is no mode, and it used to be dropped without a word.
  if (values['network-strict'] && !values.network) throw new Error('--network-strict needs --network: it refuses a provider that cannot hold every process to that mode');
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
  const [{ serve }, { runTool }, { DEFAULT_CONFIG }, { launchJobs }] = await Promise.all([
    import('@husk-ai/server'),
    import('./tools.js'),
    import('@husk-ai/core'),
    import('./daemon.js'),
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
    // Bots' triggers go to a job host of their own, started when a bot has one.
    await serve({ daemon: true, mintToken: true, deps: { runTool }, startJobs: launchJobs });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      process.stderr.write('husk daemon: the port is taken, so another Husk is already serving; exiting\n');
      process.exit(0);
    }
    throw err;
  }
}

/**
 * The job host: bots' schedules, webhooks and chat triggers, one per machine,
 * started by the shared Husk when a bot has a trigger. It runs each bot by
 * asking the shared Husk, starting that when it is not running, and leaves
 * once no bot has a trigger.
 */
async function runJobs(): Promise<void> {
  const [{ readJobsRecord, serveJobs }, { connectDaemon }, { HuskError, createLogger, readDaemonRecord }] = await Promise.all([
    import('@husk-ai/server'),
    import('./daemon.js'),
    import('@husk-ai/core'),
  ]);
  const log = createLogger({ scope: 'husk jobs' });
  const running = readJobsRecord();
  const answering =
    running &&
    (await fetch(`${running.url}/health`, { headers: { authorization: `Bearer ${running.token}` }, signal: AbortSignal.timeout(1000) }).then(
      (r) => r.ok,
      () => false,
    ));
  if (answering) {
    process.stderr.write('husk jobs: a job host already answers; exiting\n');
    process.exit(0);
  }
  const shared = async () => {
    const rec = (await connectDaemon({ log })) ? readDaemonRecord() : undefined;
    if (!rec) throw new HuskError('E_PROVIDER_UNAVAILABLE', 'the shared Husk is not running and could not be started', { hint: '~/.husk/daemon.log says why' });
    return { url: rec.url, token: rec.token };
  };
  let server: Awaited<ReturnType<typeof serveJobs>> | undefined;
  // Why it left before serveJobs returned, if it did: a sync at start found no trigger.
  let idle = '';
  const leave = (why: string) => {
    log.info(`leaving: ${why}`);
    void (server?.close() ?? Promise.resolve()).then(() => process.exit(0));
  };
  server = await serveJobs({ shared, logger: log, leave: (why) => (server ? leave(why) : (idle = why)) });
  if (idle) leave(idle);
  process.once('SIGINT', () => leave('SIGINT'));
  process.once('SIGTERM', () => leave('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`husk mcp failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
