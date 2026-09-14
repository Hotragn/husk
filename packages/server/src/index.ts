/**
 * @husk-ai/server -- the control plane and the bot host.
 *
 * `createApp(deps)` builds the Fastify instance with everything injected, so it can
 * be driven with `app.inject()` and no sockets. `serve()` wires the real packages,
 * binds a port, and owns graceful shutdown.
 */

export { createApp } from './app.js';
export type { CreateAppOptions } from './app.js';

export { serve, createDefaultDeps } from './serve.js';
export type { ServeOptions, RunningServer } from './serve.js';

export { Store } from './store.js';
export type { StoreOptions, HuskSummary, RunSummary } from './store.js';

export { resolveConfig, resolveDeps, lazyAgentFactory } from './deps.js';
export type {
  AgentFactory,
  AgentInit,
  AgentLike,
  ManagerLike,
  ResolvedDeps,
  RouterLike,
  ServerConfig,
  ServerDeps,
  ServerRunOptions,
} from './deps.js';

export { createContext, ctxOf } from './context.js';
export type { ServerContext } from './context.js';

export { Runner } from './runner.js';
export type { ApprovalRequiredEvent, RunRequestBody, ServerRunEvent } from './runner.js';

export { ApprovalRegistry } from './approvals.js';
export type { PendingApproval } from './approvals.js';

export { EventBus } from './events.js';
export type { EventTopic, HuskEvent } from './events.js';

export { SseStream, pipeSse } from './sse.js';
export type { SseOptions } from './sse.js';

export {
  errorBody,
  huskError,
  installErrorHandling,
  invalidSpec,
  notFound,
  sendError,
  statusForCode,
  SERVER_ERROR_CODES,
} from './errors.js';
export type { ErrorBody, ServerErrorCode } from './errors.js';

export { assertBindIsSafe, bearerToken, installAuth, isLoopbackHost } from './auth.js';
export type { AuthOptions } from './auth.js';

export { CronScheduler, nextFireTime, nextFireTimes, parseCron } from './cron.js';
export type { CronExpression, CronJob } from './cron.js';

export {
  CronBindings,
  TriggerHost,
  createTriggerHost,
  hmacHex,
  safeCompareHex,
  verifyHmacSignature,
} from './triggers/index.js';
export type { MountedTrigger } from './triggers/index.js';

export { findConsoleDir, installConsole } from './console.js';

export type { DoctorModelProvider, DoctorProvider, DoctorReport } from './routes/doctor.js';
