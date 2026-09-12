import { DEFAULT_CONFIG, createLogger } from '@husk/core';
import type {
  Availability,
  ChatRequest,
  ChatResponse,
  Computer,
  ComputerInfo,
  ComputerSpec,
  HuskSpec,
  Logger,
  ModelInfo,
  ModelProvider,
  ProviderName,
  RunEvent,
  RunOptions,
  RunResult,
  StreamEvent,
  Tool,
  ToolCallPart,
  Approver,
} from '@husk/core';
import { Store } from './store.js';
import { huskError } from './errors.js';

/**
 * The computer surface the server actually uses.
 *
 * Structural rather than `instanceof ComputerManager`, so a test injects a plain
 * object and never touches Docker, WSL or the filesystem.
 */
export interface ManagerLike {
  status(
    force?: boolean,
  ): Promise<Array<Availability & { name: ProviderName; description: string; priority: number }>>;
  create(spec?: ComputerSpec): Promise<Computer>;
  get(id: string): Promise<Computer | null>;
  list(): Promise<ComputerInfo[]>;
  destroy(id: string): Promise<boolean>;
  ensure?(key: string, spec?: ComputerSpec): Promise<Computer>;
  reap?(): Promise<string[]>;
  startReaper?(intervalMs?: number): void;
  stopReaper?(): void;
}

/**
 * The one method the agent actually needs from a manager.
 *
 * `AgentInit.computers` asked for a whole `ManagerLike`, which is why pinning a
 * run to an existing computer looked like it needed a contract change. It did
 * not -- the agent calls `ensure` and nothing else, so anything that can answer
 * `ensure` is a valid source, including one that always returns the same
 * machine. See `pinnedSource` in runner.ts.
 */
export interface ComputerSourceLike {
  ensure(key: string, spec?: ComputerSpec): Promise<Computer>;
}

export interface RouterLike {
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

/**
 * `RunOptions` with the approval hook narrowed to required-by-name.
 *
 * Core owns `Approver` and the `approval_required` event; this alias exists only
 * so the server's own signatures read clearly at their call sites.
 */
export interface ServerRunOptions extends RunOptions {
  onApproval?: Approver;
}

export interface AgentLike {
  run(opts: ServerRunOptions): Promise<RunResult>;
  stream(opts: ServerRunOptions): AsyncIterable<RunEvent>;
}

export interface AgentInit {
  spec: HuskSpec;
  router: RouterLike;
  computers: ManagerLike | ComputerSourceLike;
  tools?: Tool[];
}

export type AgentFactory = (init: AgentInit) => Promise<AgentLike>;

/**
 * Build an agent without importing `@husk/agent` at module load.
 *
 * `husk serve` has to come up even when a sibling package is mid-rebuild or
 * half-installed: an import error should cost you `POST /v1/husks/:name/run`, not
 * the whole control plane.
 */
export const lazyAgentFactory: AgentFactory = async (init) => {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('@husk/agent')) as Record<string, unknown>;
  } catch (err) {
    throw huskError('E_NOT_IMPLEMENTED', `@husk/agent could not be loaded: ${(err as Error).message}`, {
      hint: 'run `npm run build --workspace=@husk/agent`, then retry',
      cause: err,
    });
  }
  const Ctor = mod['Agent'] as (new (init: AgentInit) => AgentLike) | undefined;
  if (typeof Ctor !== 'function') {
    throw huskError('E_NOT_IMPLEMENTED', '@husk/agent does not export an Agent class', {
      hint: 'expected `new Agent({ spec, router, computers, tools })` with run() and stream()',
    });
  }
  return new Ctor(init);
};

export interface ServerConfig {
  host: string;
  port: number;
  token?: string | undefined;
  maxComputers: number;
  /** Absolute path to the built console. Missing is fine; a placeholder is served. */
  consoleDir?: string | undefined;
  /** CORS origins. Loopback-only by default, because this API executes shell commands. */
  corsOrigins?: string[] | boolean;
  /** Turn the cron/http/webhook trigger host off, e.g. in tests. */
  triggers?: boolean;
  /** Turn the chat adapters off. Also off whenever their tokens are absent. */
  adapters?: boolean;
  bodyLimitBytes?: number;
}

export interface ServerDeps {
  manager: ManagerLike;
  router: RouterLike;
  store: Store;
  /** Enumerated for `GET /v1/models`; the router itself exposes no listing. */
  modelProviders?: ModelProvider[];
  agentFactory?: AgentFactory;
  logger?: Logger;
  config?: Partial<ServerConfig>;
  /** Injected for deterministic tests. */
  now?: () => number;
}

export interface ResolvedDeps extends Required<Pick<ServerDeps, 'manager' | 'router' | 'store'>> {
  modelProviders: ModelProvider[];
  agentFactory: AgentFactory;
  log: Logger;
  config: ServerConfig;
  now: () => number;
  startedAt: number;
}

export function resolveConfig(partial: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  const port = partial.port ?? (env['HUSK_PORT'] ? Number.parseInt(env['HUSK_PORT'], 10) : DEFAULT_CONFIG.port);
  const cfg: ServerConfig = {
    host: partial.host ?? env['HUSK_HOST'] ?? DEFAULT_CONFIG.host,
    port: Number.isFinite(port) ? port : DEFAULT_CONFIG.port,
    token: partial.token ?? (env['HUSK_TOKEN'] || undefined),
    maxComputers: partial.maxComputers ?? DEFAULT_CONFIG.maxComputers,
    consoleDir: partial.consoleDir,
    corsOrigins: partial.corsOrigins ?? false,
    triggers: partial.triggers ?? true,
    adapters: partial.adapters ?? true,
    bodyLimitBytes: partial.bodyLimitBytes ?? 32 * 1024 * 1024,
  };
  return cfg;
}

export function resolveDeps(deps: ServerDeps): ResolvedDeps {
  return {
    manager: deps.manager,
    router: deps.router,
    store: deps.store,
    modelProviders: deps.modelProviders ?? [],
    agentFactory: deps.agentFactory ?? lazyAgentFactory,
    log: deps.logger ?? createLogger({ scope: 'server' }),
    config: resolveConfig(deps.config),
    now: deps.now ?? Date.now,
    startedAt: (deps.now ?? Date.now)(),
  };
}

export type { ModelInfo };
