import { defaultSpec } from '@husk-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  Computer,
  ComputerInfo,
  ComputerSpec,
  DirEntry,
  ExecRequest,
  ExecResult,
  HuskSpec,
  HuskSpecInput,
  ModelInfo,
  PortBinding,
  StreamEvent,
  ToolCallPart,
  Usage,
  WriteFileOptions,
} from '@husk-ai/core';
import type { ComputerSource, RouterLike } from './types.js';

/** Test doubles. Not exported from the package entry point. */

export interface ScriptedTurn {
  text?: string;
  thinking?: string;
  toolCalls?: ToolCallPart[];
  usage?: Usage;
  /** Milliseconds of abortable delay before anything is yielded. */
  delayMs?: number;
  /** Emitted before `done`, to exercise the warning path. */
  error?: { message: string; code?: string; retryable?: boolean };
  /** Skip the terminal `done` event, as a stream that dies mid-flight would. */
  omitDone?: boolean;
  events?: StreamEvent[];
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export class FakeRouter implements RouterLike {
  /** Deep snapshots of every request, taken before the loop mutates its arrays. */
  readonly requests: ChatRequest[] = [];
  readonly chatRequests: ChatRequest[] = [];
  chatResponse: ChatResponse | undefined;

  constructor(
    private readonly turns: ScriptedTurn[],
    private readonly info?: ModelInfo | null,
  ) {}

  async getModelInfo(): Promise<ModelInfo | null> {
    return this.info ?? null;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.chatRequests.push(snapshot(req));
    return (
      this.chatResponse ?? {
        model: req.model,
        text: 'a summary of the middle',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
        latencyMs: 1,
      }
    );
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(snapshot(req));
    const turn = this.turns.shift() ?? { text: 'done.' };
    if (turn.delayMs) await abortableDelay(turn.delayMs, req.signal);
    if (turn.events) {
      yield* turn.events;
      return;
    }

    yield { type: 'start', model: req.model };
    if (turn.thinking) {
      for (const chunk of chunks(turn.thinking)) yield { type: 'thinking_delta', text: chunk };
    }
    if (turn.text) {
      for (const chunk of chunks(turn.text)) yield { type: 'text_delta', text: chunk };
    }
    for (const call of turn.toolCalls ?? []) yield { type: 'tool_call', call };
    if (turn.error) yield { type: 'error', error: turn.error };

    const usage = turn.usage ?? { inputTokens: 100, outputTokens: 20, costUsd: 0 };
    yield { type: 'usage', usage };
    if (turn.omitDone) return;
    yield {
      type: 'done',
      response: {
        model: req.model,
        text: turn.text ?? '',
        thinking: turn.thinking,
        toolCalls: turn.toolCalls ?? [],
        finishReason: turn.toolCalls?.length ? 'tool_calls' : 'stop',
        usage,
        latencyMs: 1,
      },
    };
  }
}

function chunks(text: string): string[] {
  const out = text.match(/.{1,6}/gs);
  return out ?? [text];
}

function snapshot(req: ChatRequest): ChatRequest {
  return { ...req, messages: JSON.parse(JSON.stringify(req.messages)) as ChatRequest['messages'], signal: undefined };
}

export interface FakeComputerOptions {
  files?: Record<string, string>;
  exec?: (req: ExecRequest) => Partial<ExecResult> | Promise<Partial<ExecResult>>;
  id?: string;
  provider?: string;
}

export class FakeComputer implements Computer {
  readonly id: string;
  readonly info: ComputerInfo;
  readonly files = new Map<string, string>();
  readonly execs: ExecRequest[] = [];
  readonly exposed: number[] = [];
  destroyed = false;

  private readonly execHandler: FakeComputerOptions['exec'];

  constructor(opts: FakeComputerOptions = {}) {
    this.id = opts.id ?? 'cmp_fake';
    this.execHandler = opts.exec;
    for (const [k, v] of Object.entries(opts.files ?? {})) this.files.set(k, v);
    this.info = {
      id: this.id,
      name: 'fake',
      provider: opts.provider ?? 'local',
      state: 'running',
      image: 'fake:latest',
      workdir: '/work',
      createdAt: new Date(0).toISOString(),
      lastUsedAt: new Date(0).toISOString(),
      spec: {},
    };
  }

  async refresh(): Promise<ComputerInfo> {
    return this.info;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    this.execs.push(req);
    if (req.signal?.aborted) throw new Error('aborted');
    const partial = (await this.execHandler?.(req)) ?? {};
    const stdout = partial.stdout ?? '';
    const stderr = partial.stderr ?? '';
    if (stdout) req.onStdout?.(stdout);
    if (stderr) req.onStderr?.(stderr);
    return {
      exitCode: partial.exitCode ?? 0,
      stdout,
      stderr,
      durationMs: partial.durationMs ?? 1,
      truncated: partial.truncated ?? false,
      timedOut: partial.timedOut ?? false,
    };
  }

  async writeFile(path: string, content: string | Uint8Array, _opts?: WriteFileOptions): Promise<void> {
    const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    if (_opts?.append) this.files.set(path, (this.files.get(path) ?? '') + text);
    else this.files.set(path, text);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return Buffer.from(await this.readTextFile(path), 'utf8');
  }

  async readTextFile(path: string, maxBytes = Infinity): Promise<string> {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`no such file: ${path}`);
    const buf = Buffer.from(text, 'utf8');
    return buf.byteLength <= maxBytes ? text : buf.subarray(0, maxBytes).toString('utf8');
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const prefix = path.endsWith('/') ? path : path + '/';
    const seen = new Map<string, DirEntry>();
    for (const [full, content] of this.files) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        seen.set(rest, {
          name: rest,
          path: full,
          type: 'file',
          size: Buffer.byteLength(content, 'utf8'),
        });
      } else {
        const dir = rest.slice(0, slash);
        seen.set(dir, { name: dir, path: prefix + dir, type: 'dir', size: 0 });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async stat(path: string): Promise<DirEntry | null> {
    const content = this.files.get(path);
    if (content !== undefined) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      return { name, path, type: 'file', size: Buffer.byteLength(content, 'utf8') };
    }
    const prefix = path.endsWith('/') ? path : path + '/';
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        return { name: path.slice(path.lastIndexOf('/') + 1), path, type: 'dir', size: 0 };
      }
    }
    return null;
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(path)) return;
    if (!opts?.recursive) return;
    const prefix = path.endsWith('/') ? path : path + '/';
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
  }

  async upload(): Promise<void> {}
  async download(): Promise<void> {}

  async exposePort(port: number): Promise<PortBinding> {
    this.exposed.push(port);
    return { hostPort: 30000 + port, url: `http://localhost:${30000 + port}` };
  }

  async stop(): Promise<void> {}
  async start(): Promise<void> {}
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export class FakeComputerSource implements ComputerSource {
  calls = 0;
  readonly computer: FakeComputer;
  /** Every spec the loop handed us, so a test can assert what it translated. */
  readonly specs: Array<ComputerSpec | undefined> = [];

  constructor(computer?: FakeComputer) {
    this.computer = computer ?? new FakeComputer();
  }

  async ensure(_key: string, spec?: ComputerSpec): Promise<Computer> {
    this.calls += 1;
    this.specs.push(spec);
    return this.computer;
  }
}

export function specFor(patch: Partial<HuskSpecInput> = {}): HuskSpec {
  const base = defaultSpec('test-husk');
  return {
    ...base,
    ...patch,
    limits: { ...base.limits, ...(patch.limits as object | undefined) },
    guardrails: { ...base.guardrails, ...(patch.guardrails as object | undefined) },
    memory: { ...base.memory, ...(patch.memory as object | undefined) },
    computer: { ...base.computer, ...(patch.computer as object | undefined) },
  } as HuskSpec;
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCallPart {
  return { type: 'tool_call', id, name, args };
}
