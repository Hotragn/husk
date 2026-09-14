import { createLogger, ensurePaths } from '@husk/core';
import type { Logger, ModelProvider } from '@husk/core';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import type { CreateAppOptions } from './app.js';
import { resolveConfig } from './deps.js';
import type { ManagerLike, RouterLike, ServerConfig, ServerDeps } from './deps.js';
import { Store } from './store.js';

export interface ServeOptions extends Partial<ServerConfig> {
  logger?: Logger;
  /** Supply your own wiring; anything omitted is constructed from the real packages. */
  deps?: Partial<ServerDeps>;
  /** Interval for the computer reaper. 0 disables it. */
  reaperIntervalMs?: number;
}

export interface RunningServer {
  app: FastifyInstance;
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
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

  let manager: ManagerLike;
  try {
    const { ComputerManager } = await import('@husk/runtime');
    manager = new ComputerManager({ maxComputers: config.maxComputers, logger: log.child('runtime') });
  } catch (err) {
    log.error(`@husk/runtime failed to load: ${(err as Error).message}`);
    manager = unavailableManager((err as Error).message);
  }

  let router: RouterLike;
  let modelProviders: ModelProvider[] = [];
  try {
    const models = (await import('@husk/models')) as Record<string, unknown>;
    const RouterCtor = models['ModelRouter'] as (new () => RouterLike) | undefined;
    if (!RouterCtor) throw new Error('@husk/models does not export ModelRouter');
    router = new RouterCtor();
    modelProviders = instantiateModelProviders(models, log);
  } catch (err) {
    log.error(`@husk/models failed to load: ${(err as Error).message}`);
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

  const { logger: _logger, deps: injected, reaperIntervalMs, ...configish } = opts;
  const config = resolveConfig(configish);
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

  const app = await createApp(appOptions);
  const ctx = app.husk;

  const reaperMs = reaperIntervalMs ?? 60_000;
  if (reaperMs > 0) ctx.deps.manager.startReaper?.(reaperMs);

  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;

  log.info(`husk serve listening on ${url}`);
  if (!config.token) log.info('no HUSK_TOKEN set -- loopback connections only');

  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    closing ??= (async () => {
      log.info('shutting down');
      ctx.triggers?.stop();
      ctx.scheduler.stop();
      ctx.deps.manager.stopReaper?.();
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
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { app, url, host: config.host, port, close };
}
