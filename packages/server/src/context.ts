import type { FastifyInstance } from 'fastify';
import type { ResolvedDeps } from './deps.js';
import { EventBus } from './events.js';
import { Runner } from './runner.js';
import { CronScheduler } from './cron.js';
import type { TriggerHost } from './triggers/index.js';

export interface ServerContext {
  deps: ResolvedDeps;
  bus: EventBus;
  runner: Runner;
  scheduler: CronScheduler;
  triggers?: TriggerHost;
}

export function createContext(deps: ResolvedDeps, opts: { approvalTimeoutMs?: number } = {}): ServerContext {
  const bus = new EventBus();
  const runner = new Runner(deps, bus, opts);
  const scheduler = new CronScheduler({
    onError: (err, job) => deps.log.error(`cron job ${job.id} failed`, err),
  });
  return { deps, bus, runner, scheduler };
}

export function ctxOf(app: FastifyInstance): ServerContext {
  return app.husk;
}

declare module 'fastify' {
  interface FastifyInstance {
    husk: ServerContext;
  }
}
