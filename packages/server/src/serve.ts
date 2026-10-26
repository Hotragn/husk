import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { HUSK_PROTOCOL, HUSK_VERSION, clearDaemonRecord, createLogger, ensurePaths, loadConfig, writeDaemonRecord } from '@husk-ai/core';
import type { Logger, ModelProvider } from '@husk-ai/core';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { startChatIdleStop } from './chat-idle.js';
import { JobsLink, clearJobsRecord, createJobsApp, dismissJobHost, remoteRunner, writeJobsRecord } from './jobs.js';
import type { SharedHusk } from './jobs.js';
import type { CreateAppOptions } from './app.js';
import { resolveConfig } from './deps.js';
import type { ManagerLike, RouterLike, ServerConfig, ServerDeps } from './deps.js';
import { PUBLIC_HEADER, isLoopbackHost } from './auth.js';
import { huskError } from './errors.js';
import { checkThisInstall } from './remote/advisories.js';
import { Remote } from './remote/oauth.js';
import { Store } from './store.js';

export interface ServeOptions extends Partial<ServerConfig> {
  logger?: Logger;
  /** Supply your own wiring; anything omitted is constructed from the real packages. */
  deps?: Partial<ServerDeps>;
  /** Interval for the computer reaper. 0 disables it. */
  reaperIntervalMs?: number;
  /** Be the machine's one Husk: write ~/.husk/daemon.json so chats' MCP processes find this server. */
  daemon?: boolean;
  /**
   * Mint a token when none was given. For the Husk a chat starts in the
   * background, which has nobody to configure one. `husk serve` keeps its
   * old contract: tokenless on loopback, and a refusal to bind further without one.
   */
  mintToken?: boolean;
  /**
   * Start the job host (jobs.ts). The Husk chats start passes it: it then mounts
   * no trigger of its own, forwards the trigger routes to the job host, and
   * starts it whenever a bot has a trigger. Without it, as for `husk serve`,
   * triggers run in this process as before.
   */
  startJobs?: () => void;
  /**
   * Remote access (remote/oauth.ts): `/mcp` under the fixed public URL a
   * tunnel gives remote access's own port, for the owner alone, on computers
   * from an isolated provider. That port is `port` (default: the API's plus
   * one, or any free one when the API's is) on `host` (default loopback, where
   * a tunnel connects; 0.0.0.0 in a container behind its own proxy).
   */
  remote?: { publicUrl: string; provider: string; port?: number; host?: string };
}

export interface RunningServer {
  app: FastifyInstance;
  url: string;
  /** Remote access is on and has no owner yet: the code to show the person, here and nowhere else. */
  claimCode?: string;
  /** Remote access's own port: the one to publish with the tunnel. */
  remotePort?: number;
  /** For the terminal: advisories short of high, a check that could not be made, a new public URL. */
  warnings?: string[];
  host: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Remote access's own port. Every request on it is marked as from the public
 * URL (auth.ts `PUBLIC_HEADER`) and named for it, whatever its Host header
 * says: a tunnel passes Host on as the caller wrote it, so a caller writing
 * `Host: 127.0.0.1` must still reach the remote paths and nothing else. The
 * API's own port answers none of them, so the console and the API stay on
 * this machine whatever the tunnel lets through.
 */
async function servePublic(app: FastifyInstance, remote: Remote, host: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    req.headers[PUBLIC_HEADER] = remote.mark;
    req.headers.host = remote.host;
    app.routing(req, res);
  });
  // No WebSocket or other upgrade: the pages under the public URL poll over plain HTTP.
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

/**
 * Construct the real dependencies.
 *
 * Each import is dynamic and independently guarded: a half-built sibling package
 * should cost you that package's endpoints, not the entire control plane. A server
 * that will not start is much harder to debug than one that starts and tells you
 * which provider is missing.
 */
export async function createDefaultDeps(
  config: ServerConfig,
  log: Logger,
): Promise<{ manager: ManagerLike; router: RouterLike; store: Store; modelProviders: ModelProvider[] }> {
  const store = new Store();
  await store.init();
  // This machine's settings, ~/.husk/config.json: what `auto` means, the model aliases, the router's ceiling.
  const machine = loadConfig();

  let manager: ManagerLike;
  try {
    const { ComputerManager } = await import('@husk-ai/runtime');
    manager = new ComputerManager({ maxComputers: config.maxComputers, provider: machine.provider, logger: log.child('runtime') });
  } catch (err) {
    log.error(`@husk-ai/runtime failed to load: ${(err as Error).message}`);
    manager = unavailableManager((err as Error).message);
  }

  let router: RouterLike;
  let modelProviders: ModelProvider[] = [];
  try {
    const models = (await import('@husk-ai/models')) as Record<string, unknown>;
    const RouterCtor = models['ModelRouter'] as (new (opts: { aliases: Record<string, string>; maxCostUsd: number }) => RouterLike) | undefined;
    if (!RouterCtor) throw new Error('@husk-ai/models does not export ModelRouter');
    router = new RouterCtor({ aliases: machine.modelAliases, maxCostUsd: machine.maxCostUsd });
    modelProviders = instantiateModelProviders(models, log);
  } catch (err) {
    log.error(`@husk-ai/models failed to load: ${(err as Error).message}`);
    router = unavailableRouter((err as Error).message);
  }

  return { manager, router, store, modelProviders };
}

/**
 * `ModelRouter` keeps its provider map private and offers no listing, so
 * `GET /v1/models` cannot ask it what exists. The exported provider classes are
 * instantiated here instead. See README.md for the upstream change that removes this.
 */
function instantiateModelProviders(models: Record<string, unknown>, log: Logger): ModelProvider[] {
  const out: ModelProvider[] = [];
  for (const [name, value] of Object.entries(models)) {
    if (typeof value !== 'function' || !name.endsWith('Provider')) continue;
    try {
      const instance = new (value as new () => ModelProvider)();
      if (typeof instance.isAvailable === 'function' && typeof instance.listModels === 'function' && instance.id) {
        out.push(instance);
      }
    } catch (err) {
      log.debug(`model provider ${name} could not be constructed`, err);
    }
  }
  return out.sort((a, b) => b.priority - a.priority);
}

function unavailableManager(reason: string): ManagerLike {
  const fail = (): never => {
    throw new Error(`the computer runtime is not available: ${reason}`);
  };
  return {
    status: async () => [],
    create: async () => fail(),
    get: async () => null,
    list: async () => [],
    destroy: async () => false,
  };
}

function unavailableRouter(reason: string): RouterLike {
  const fail = (): never => {
    throw new Error(`the model router is not available: ${reason}`);
  };
  return {
    chat: async () => fail(),
    // eslint-disable-next-line require-yield
    stream: async function* () {
      fail();
    },
  };
}

/**
 * Bring the control plane up and keep it up.
 *
 * Shutdown is the interesting half. SIGINT during a run must stop accepting
 * connections, abort the runs in flight so no container is left spinning, stop the
 * reaper and the cron scheduler, and flush the write queue -- in that order, and
 * only once however many signals arrive.
 */
export async function serve(opts: ServeOptions = {}): Promise<RunningServer> {
  const log = opts.logger ?? createLogger({ scope: 'husk' });
  ensurePaths();

  const { logger: _logger, deps: injected, reaperIntervalMs, daemon, mintToken, startJobs, remote: remoteOpts, ...configish } = opts;
  const config = resolveConfig(configish);
  // Remote access always has one: its owner controls are on this API, and without a
  // token any process on the machine could reset the owner and claim it.
  if ((mintToken || remoteOpts) && !config.token) config.token = randomBytes(32).toString('hex');
  const built = await createDefaultDeps(config, log);

  const appOptions: CreateAppOptions = {
    manager: injected?.manager ?? built.manager,
    router: injected?.router ?? built.router,
    store: injected?.store ?? built.store,
    modelProviders: injected?.modelProviders ?? built.modelProviders,
    logger: log,
    config,
  };
  if (injected?.agentFactory) appOptions.agentFactory = injected.agentFactory;
  if (injected?.runTool) appOptions.runTool = injected.runTool;
  if (injected?.remoteMcp) appOptions.remoteMcp = injected.remoteMcp;
  let claimCode: string | undefined;
  let remote: Remote | undefined;
  const warnings: string[] = [];
  if (remoteOpts) {
    // The tunnel connects to remote access's own port; anything wider here would put the API itself on the network.
    if (!isLoopbackHost(config.host)) {
      throw huskError('E_CONFIG', 'remote access keeps this API on loopback: the tunnel connects to remote access’s own port', {
        hint: 'leave out --host; --remote-host sets where remote access’s port listens',
      });
    }
    // Never this machine's own files: a computer from a provider with a real boundary, or none.
    const provider = (await appOptions.manager.status()).find((p) => p.name === remoteOpts.provider);
    if (!provider?.available || provider.isolated !== true || provider.isolationKind === 'guardrails') {
      throw huskError('E_CONFIG', `remote access needs an isolated computer, and ${remoteOpts.provider} is not one here: ${provider?.reason ?? 'it is not available'}`, {
        hint: 'start Docker, or pass --provider podman, fly or ssh',
      });
    }
    remote = new Remote({ publicUrl: remoteOpts.publicUrl, dir: join(ensurePaths().root, 'remote'), advisories: checkThisInstall });
    const started = await remote.start();
    claimCode = started.claimCode;
    warnings.push(...started.warnings);
    if (started.movedFrom) warnings.push(`the public URL was ${started.movedFrom}: its owner, apps and tokens belonged to that name, so they are forgotten`);
    if (!isLoopbackHost(remoteOpts.host ?? '127.0.0.1')) {
      warnings.push(`remote access’s port listens on ${remoteOpts.host}: right in a container behind its own proxy; on a computer of your own, a tunnel to loopback is safer`);
    }
    appOptions.remote = remote;
  }
  // The machine's one Husk keeps holds across its restarts. A second server on
  // the same home would fight it over the file, so only the shared one does.
  if (daemon) appOptions.holdsFile = join(ensurePaths().root, 'holds.json');
  // Bots' triggers live in a job host of their own, apart from the Husk the chats start (F-15).
  const jobs = daemon && startJobs ? new JobsLink({ start: startJobs, store: appOptions.store, log }) : undefined;
  if (jobs) appOptions.jobs = jobs;

  const app = await createApp(appOptions);
  const ctx = app.husk;

  const reaperMs = reaperIntervalMs ?? 60_000;
  if (reaperMs > 0) ctx.deps.manager.startReaper?.(reaperMs);
  // The machine's one Husk owns its chats' computers, idle stop included.
  const stopSweeping = daemon ? startChatIdleStop(ctx) : undefined;

  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;
  let publicServer: Server | undefined;
  if (remote) {
    try {
      publicServer = await servePublic(app, remote, remoteOpts?.host ?? '127.0.0.1', remoteOpts?.port ?? (config.port === 0 ? 0 : port + 1));
    } catch (err) {
      remote.close();
      await app.close();
      throw huskError('E_CONFIG', `remote access could not listen on its own port: ${(err as Error).message}`, { hint: 'pass --remote-port with a free port' });
    }
  }
  const remotePort = publicServer ? (publicServer.address() as AddressInfo).port : undefined;

  log.info(`husk serve listening on ${url}`);
  if (remotePort !== undefined) log.info(`remote access listening on port ${remotePort}`);
  if (daemon) {
    writeDaemonRecord({
      url,
      token: config.token ?? null,
      pid: process.pid,
      version: HUSK_VERSION,
      protocol: HUSK_PROTOCOL,
      startedAt: new Date().toISOString(),
    });
  }
  if (!config.token) log.info('no HUSK_TOKEN set -- loopback connections only');
  // A bot with a trigger has its job host from the start, not from the first webhook.
  if (jobs) void jobs.sync().catch((err: unknown) => log.error('the job host could not be started', err));
  else if (daemon) void dismissJobHost();

  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    closing ??= (async () => {
      log.info('shutting down');
      if (daemon) clearDaemonRecord();
      remote?.close();
      if (publicServer) {
        const closed = new Promise((resolve) => publicServer!.close(resolve));
        publicServer.closeAllConnections();
        await closed;
      }
      await ctx.triggers?.stop();
      ctx.scheduler.stop();
      ctx.deps.manager.stopReaper?.();
      stopSweeping?.();
      const cancelled = ctx.runner.cancelAll('server shutting down');
      if (cancelled) log.info(`cancelled ${cancelled} in-flight run(s)`);
      await app.close();
      await ctx.deps.store.close();
      log.info('stopped');
    })();
    return closing;
  };

  const onSignal = (signal: NodeJS.Signals) => {
    log.info(`received ${signal}`);
    void close().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('shutdown failed', err);
        process.exit(1);
      },
    );
  };
  ctx.shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return {
    app,
    url,
    host: config.host,
    port,
    close,
    ...(claimCode ? { claimCode } : {}),
    ...(remotePort !== undefined ? { remotePort } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Be the job host (jobs.ts): the husks' triggers on a loopback port of its
 * own (HUSK_JOBS_PORT, or any free one), with a minted token, and every run
 * asked of the shared Husk that `shared` finds or starts. Writes
 * ~/.husk/jobs.json so the shared Husk finds it. `leave` runs once no husk
 * has a trigger left.
 */
export async function serveJobs(opts: { shared: () => Promise<SharedHusk>; logger?: Logger; leave?: (why: string) => void }): Promise<RunningServer> {
  const log = opts.logger ?? createLogger({ scope: 'husk jobs' });
  ensurePaths();
  const config = resolveConfig({ host: '127.0.0.1', port: Number(process.env.HUSK_JOBS_PORT) || 0 });
  const token = randomBytes(32).toString('hex');
  config.token = token;
  const built = await createDefaultDeps(config, log);
  const app = await createJobsApp({
    deps: { ...built, logger: log, config },
    runner: remoteRunner(opts.shared),
    token,
    ...(opts.leave ? { leave: opts.leave } : {}),
  });
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://127.0.0.1:${port}`;
  writeJobsRecord({ url, token, pid: process.pid, version: HUSK_VERSION, startedAt: new Date().toISOString() });
  log.info(`husk jobs listening on ${url}`);
  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    closing ??= (async () => {
      clearJobsRecord();
      await app.husk.triggers?.stop();
      await app.close();
      await built.store.close();
    })();
    return closing;
  };
  return { app, url, host: config.host, port, close };
}
