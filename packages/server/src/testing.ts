import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, defaultSpec } from '@husk-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  Computer,
  ComputerInfo,
  ComputerSpec,
  DirEntry,
  ExecRequest,
  ExecResult,
  HuskPaths,
  ModelProvider,
  PortBinding,
  RunEvent,
  RunResult,
  StreamEvent,
} from '@husk-ai/core';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import type { AgentFactory, AgentLike, ManagerLike, RouterLike, ServerRunOptions } from './deps.js';
import { Store } from './store.js';

/**
 * Fakes for the three injected dependencies.
 *
 * Exported rather than kept in a test file because the same doubles are useful to
 * anything embedding the server -- the CLI's tests, the SDK's contract tests --
 * and duplicating them is how two suites quietly start testing different things.
 */

export function paths(root: string): HuskPaths {
  return {
    root,
    husks: join(root, 'husks'),
    computers: join(root, 'computers'),
    workspaces: join(root, 'workspaces'),
    runs: join(root, 'runs'),
    transcripts: join(root, 'transcripts'),
    data: join(root, 'data'),
    cache: join(root, 'cache'),
    configFile: join(root, 'config.json'),
    envFile: join(root, '.env'),
  };
}

export async function tempStore(): Promise<{ store: Store; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'husk-test-'));
  const store = new Store({ paths: paths(root) });
  await store.init();
  return { store, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export class FakeComputer implements Computer {
  readonly info: ComputerInfo;
  execCalls: ExecRequest[] = [];
  private readonly files = new Map<string, Uint8Array>();

  constructor(
    id: string,
    spec: ComputerSpec = {},
    private readonly execResult: Partial<ExecResult> = {},
  ) {
    this.info = {
      id,
      name: spec.name ?? id,
      provider: spec.provider ?? 'local',
      state: 'running',
      image: spec.image ?? 'husk/base',
      workdir: spec.workdir ?? '/work',
      createdAt: new Date(0).toISOString(),
      lastUsedAt: new Date(0).toISOString(),
      spec,
    };
  }

  get id(): string {
    return this.info.id;
  }

  async refresh(): Promise<ComputerInfo> {
    return this.info;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    this.execCalls.push(req);
    const result: ExecResult = {
      exitCode: 0,
      stdout: `ran: ${Array.isArray(req.cmd) ? req.cmd.join(' ') : req.cmd}\n`,
      stderr: '',
      durationMs: 1,
      truncated: false,
      timedOut: false,
      ...this.execResult,
    };
    req.onStdout?.(result.stdout);
    if (result.stderr) req.onStderr?.(result.stderr);
    return result;
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.files.set(path, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    return f;
  }

  async readTextFile(path: string): Promise<string> {
    return Buffer.from(await this.readFile(path)).toString('utf8');
  }

  async listDir(path: string): Promise<DirEntry[]> {
    return [...this.files.keys()]
      .filter((p) => p.startsWith(path))
      .map((p) => ({ name: p.split('/').pop() ?? p, path: p, type: 'file' as const, size: this.files.get(p)!.length }));
  }

  async stat(path: string): Promise<DirEntry | null> {
    const f = this.files.get(path);
    return f ? { name: path, path, type: 'file', size: f.length } : null;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async upload(): Promise<void> {}
  async download(): Promise<void> {}

  async exposePort(port: number): Promise<PortBinding> {
    return { hostPort: port, url: `http://127.0.0.1:${port}` };
  }

  async stop(): Promise<void> {
    this.info.state = 'stopped';
  }

  async start(): Promise<void> {
    this.info.state = 'running';
  }

  async destroy(): Promise<void> {
    this.info.state = 'destroyed';
  }
}

export class FakeManager implements ManagerLike {
  readonly computers = new Map<string, FakeComputer>();
  reaperStarted = false;
  private seq = 0;

  constructor(private readonly available = true) {}

  async status(): Promise<
    Array<{ name: string; description: string; priority: number; available: boolean; isolated?: boolean; reason?: string }>
  > {
    return [
      {
        name: 'local',
        description: 'guarded working directory',
        priority: 10,
        available: this.available,
        isolated: false,
        reason: 'process guardrails, not a sandbox',
      },
    ];
  }

  async create(spec: ComputerSpec = {}): Promise<Computer> {
    const c = new FakeComputer(`cmp_${++this.seq}`, spec);
    this.computers.set(c.id, c);
    return c;
  }

  async get(id: string): Promise<Computer | null> {
    return this.computers.get(id) ?? null;
  }

  async list(): Promise<ComputerInfo[]> {
    return [...this.computers.values()].map((c) => c.info);
  }

  async destroy(id: string): Promise<boolean> {
    const c = this.computers.get(id);
    if (!c) return false;
    await c.destroy();
    this.computers.delete(id);
    return true;
  }

  startReaper(): void {
    this.reaperStarted = true;
  }

  stopReaper(): void {
    this.reaperStarted = false;
  }
}

export class FakeRouter implements RouterLike {
  requests: ChatRequest[] = [];

  constructor(private readonly reply = 'fake reply') {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    return {
      model: req.model,
      text: this.reply,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
      latencyMs: 1,
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    yield { type: 'start', model: req.model };
    yield { type: 'text_delta', text: this.reply };
    yield { type: 'done', response: await this.chat(req) };
  }
}

export const fakeModelProvider: ModelProvider = {
  id: 'fake',
  displayName: 'Fake',
  priority: 1,
  isAvailable: async () => ({ available: true }),
  listModels: async () => [
    {
      id: 'fake/tiny',
      provider: 'fake',
      name: 'tiny',
      displayName: 'Tiny',
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      free: true,
    },
  ],
  chat: async (req) => ({
    model: req.model,
    text: 'ok',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    latencyMs: 1,
  }),
  // eslint-disable-next-line require-yield
  stream: async function* () {
    throw new Error('not used');
  },
};

export interface FakeAgentScript {
  events?: RunEvent[];
  text?: string;
  /** Throw instead of completing. */
  fail?: Error;
  /** Ask for approval on this tool call before finishing. */
  approvalFor?: { id: string; name: string; args: Record<string, unknown> };
  /** Block until this resolves, so a test can cancel mid-run. */
  hold?: Promise<void>;
}

export function fakeAgentFactory(script: FakeAgentScript = {}): AgentFactory {
  return async (): Promise<AgentLike> => {
    const text = script.text ?? 'done';

    const finish = (steps: number): RunResult => ({
      runId: 'agent_own_id',
      text,
      messages: [{ role: 'assistant', content: text }],
      steps,
      usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.001 },
      durationMs: 2,
      stopReason: 'complete',
    });

    const body = async function* (opts: ServerRunOptions): AsyncGenerator<RunEvent> {
      yield { type: 'run_start', runId: 'agent_own_id', husk: 'fake', model: opts.model ?? 'auto' };
      if (script.approvalFor && opts.onApproval) {
        const approved = await opts.onApproval({
          runId: 'agent_own_id',
          huskId: 'fake',
          tool: script.approvalFor.name,
          callId: script.approvalFor.id,
          args: script.approvalFor.args,
          prompt: `run ${script.approvalFor.name}?`,
          dangerous: true,
        });
        yield approved
          ? { type: 'tool_start', call: { type: 'tool_call', ...script.approvalFor } }
          : { type: 'tool_denied', call: { type: 'tool_call', ...script.approvalFor }, reason: 'denied' };
      }
      if (script.hold) await script.hold;
      if (opts.signal?.aborted) throw new Error('aborted');
      if (script.fail) throw script.fail;
      for (const e of script.events ?? []) yield e;
      yield { type: 'text_delta', text };
      yield { type: 'run_end', result: finish(1) };
    };

    return {
      async run(opts: ServerRunOptions): Promise<RunResult> {
        let result: RunResult | undefined;
        for await (const e of body(opts)) {
          opts.onEvent?.(e);
          if (e.type === 'run_end') result = e.result;
        }
        return result ?? finish(0);
      },
      stream(opts: ServerRunOptions): AsyncIterable<RunEvent> {
        return body(opts);
      },
    };
  };
}

export interface TestApp {
  app: FastifyInstance;
  store: Store;
  manager: FakeManager;
  router: FakeRouter;
  root: string;
  cleanup(): Promise<void>;
}

export async function buildTestApp(
  overrides: {
    token?: string;
    host?: string;
    manager?: ManagerLike;
    router?: RouterLike;
    agent?: AgentFactory;
    triggers?: boolean;
    approvalTimeoutMs?: number;
  } = {},
): Promise<TestApp> {
  const { store, root, cleanup } = await tempStore();
  const manager = new FakeManager();
  const router = new FakeRouter();

  const app = await createApp({
    manager: overrides.manager ?? manager,
    router: overrides.router ?? router,
    store,
    modelProviders: [fakeModelProvider],
    agentFactory: overrides.agent ?? fakeAgentFactory(),
    logger: createLogger({ level: 'silent' }),
    config: {
      host: overrides.host ?? '127.0.0.1',
      port: 0,
      token: overrides.token,
      triggers: overrides.triggers ?? false,
      // A real console bundle would install a catch-all not-found handler and mask
      // the 404 shape these tests assert on.
      consoleDir: join(root, 'no-console'),
    },
    ...(overrides.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: overrides.approvalTimeoutMs } : {}),
  });

  return {
    app,
    store,
    manager,
    router,
    root,
    async cleanup() {
      await app.close();
      await store.close();
      await cleanup();
    },
  };
}

/** A minimal valid husk, ready to POST. */
export function sampleSpec(name = 'triage') {
  return { ...defaultSpec(name), description: 'a test husk' };
}
