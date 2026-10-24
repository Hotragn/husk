import type { FastifyInstance } from 'fastify';
import { ActivityLog } from './activity.js';
import { ScopedTokens } from './scoped-tokens.js';
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
  /** Every tool call on every computer, chats included, for the console's timeline. */
  activity: ActivityLog;
  /** Short-lived links to one computer or one handoff, so a chat never carries the server token. */
  scoped: ScopedTokens;
  /** Set by `serve()`: close cleanly and exit. Absent for an embedded app. */
  shutdown?: () => Promise<void>;
  /** Computers a chat runs in its own process, which this Husk cannot reach: no take-over here. */
  inChat: Set<string>;
}

export function createContext(deps: ResolvedDeps, opts: { approvalTimeoutMs?: number } = {}): ServerContext {
  const bus = new EventBus();
  const runner = new Runner(deps, bus, opts);
  const scheduler = new CronScheduler({
    onError: (err, job) => deps.log.error(`cron job ${job.id} failed`, err),
  });
  return { deps, bus, runner, scheduler, activity: new ActivityLog(), scoped: new ScopedTokens(), inChat: new Set() };
}

export function ctxOf(app: FastifyInstance): ServerContext {
  return app.husk;
}

declare module 'fastify' {
  interface FastifyInstance {
    husk: ServerContext;
  }
}
