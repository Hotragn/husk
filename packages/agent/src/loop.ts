import {
  HuskError,
  clampText,
  createLogger,
  estimateTokens,
  id,
  mapLimit,
  messageText,
  redact,
  renderPersona,
} from '@husk/core';
import type {
  ChatRequest,
  ChatResponse,
  Computer,
  ComputerSpec,
  ContentPart,
  HuskSpec,
  Logger,
  ModelMessage,
  RunResult,
  Tool,
  ToolCallPart,
  ToolResultPart,
  ToolSchema,
  Usage,
} from '@husk/core';
import { Budget, pricingOf } from './budget.js';
import { renderForSummary, trimHistory } from './memory.js';
import { EventQueue } from './queue.js';
import { resolveTools } from './tools/index.js';
import { redactEvent } from './redact-events.js';
import type {
  AgentOptions,
  AgentRunEvent,
  AgentRunOptions,
  AgentToolContext,
  ApprovalRequest,
  ComputerSource,
  RouterLike,
} from './types.js';

const TOOL_CONCURRENCY = 4;
/** Consecutive identical turns before we say something, and before we give up. */
const REPEAT_NUDGE_AT = 3;
const REPEAT_STOP_AT = 5;
/** Assumed completion length when pricing a call we have not made yet. */
const ASSUMED_OUTPUT_TOKENS = 1024;

export class Agent {
  readonly spec: HuskSpec;
  private readonly router: RouterLike;
  private readonly computers: ComputerSource | undefined;
  private readonly log: Logger;
  private readonly tools: Tool[];
  private readonly computerKey: string;
  private readonly summaryModel: string | undefined;

  constructor(opts: AgentOptions) {
    this.spec = opts.spec;
    this.router = opts.router;
    this.computers = opts.computers;
    this.log = opts.logger ?? createLogger({ scope: `agent:${opts.spec.name}` });
    this.computerKey = opts.computerKey ?? opts.spec.name;
    this.summaryModel = opts.summaryModel;
    this.tools =
      opts.tools ??
      resolveTools(opts.spec.tools, {
        spec: opts.spec,
        hasComputer: opts.spec.computer.enabled && Boolean(opts.computers),
        env: opts.env,
        logger: this.log,
      });
  }

  /** Every tool this agent will offer the model. */
  listTools(): Tool[] {
    return [...this.tools];
  }

  /** `run` is `stream` drained to completion, so there is exactly one code path. */
  async run(opts: AgentRunOptions): Promise<RunResult> {
    let result: RunResult | undefined;
    for await (const event of this.stream(opts)) {
      if (event.type === 'run_end') result = event.result;
    }
    if (!result) {
      throw new HuskError('E_INTERNAL', 'the run produced no result', {
        hint: 'this is a bug in @husk/agent; report it with the husk.yaml that triggered it',
      });
    }
    return result;
  }

  async *stream(opts: AgentRunOptions): AsyncIterable<AgentRunEvent> {
    const run = new Run(this.spec, this.router, this.computers, this.tools, this.log, opts, {
      computerKey: this.computerKey,
      summaryModel: this.summaryModel,
    });
    yield* run.execute();
  }
}

interface RunDeps {
  computerKey: string;
  summaryModel: string | undefined;
}

class Run {
  private readonly queue = new EventQueue<AgentRunEvent>();
  private readonly runId = id('run');
  private readonly messages: ModelMessage[] = [];
  private readonly trace: ChatResponse[] = [];
  private readonly state = new Map<string, unknown>();
  private readonly startedAt = Date.now();
  private readonly abort = new AbortController();

  private readonly toolsByName: Map<string, Tool>;
  private readonly budget: Budget;
  private readonly model: string;
  private readonly approvalMode: 'auto' | 'ask' | 'readonly';
  private readonly system: string;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;
  private externallyAborted = false;
  private finalText = '';
  private computer: Computer | undefined;
  private computerPromise: Promise<Computer> | undefined;
  private lastSignature: string | undefined;
  private repeatCount = 0;
  private pricingResolved = false;

  constructor(
    private readonly spec: HuskSpec,
    private readonly router: RouterLike,
    private readonly computers: ComputerSource | undefined,
    tools: Tool[],
    private readonly log: Logger,
    private readonly opts: AgentRunOptions,
    private readonly deps: RunDeps,
  ) {
    this.toolsByName = new Map(tools.map((t) => [t.name, t]));
    this.model = opts.model ?? spec.model;
    this.approvalMode = opts.approvalMode ?? spec.guardrails.approvalMode;
    this.system = renderPersona(spec, opts.vars ?? {});
    this.budget = new Budget({
      maxSteps: opts.maxSteps ?? spec.limits.maxSteps,
      maxCostUsd: opts.maxCostUsd ?? spec.limits.maxCostUsd,
      maxTokens: opts.maxTokens ?? spec.limits.maxTokens,
      timeoutMs: (opts.timeoutSec ?? spec.limits.timeoutSec) * 1000,
    });
  }

  async *execute(): AsyncIterable<AgentRunEvent> {
    this.queue.onAbandon = () => this.abort.abort(new HuskError('E_ABORTED', 'the consumer stopped reading'));

    const driver = this.drive().catch((err: unknown) => {
      // drive() is written not to throw, but a run must always end.
      const message = (err as Error).message;
      this.emit({ type: 'error', error: { message } });
      this.emit({ type: 'run_end', result: this.result('error', { message }) });
      this.queue.end();
    });

    try {
      for await (const event of this.queue) {
        this.opts.onEvent?.(event);
        yield event;
      }
    } finally {
      this.cleanup();
      await driver;
    }
  }

  /**
   * The single exit for every run event.
   *
   * Redaction belongs here, not at each call site. `tool_delta` carries raw
   * command output straight to the terminal, to every SSE client and to the run
   * log on disk, so redacting only the `tool_result` the model reads protects
   * the model and nobody else -- a token echoed by `env` still lands in three
   * places a human or a log shipper can see. At the chokepoint, a tool added
   * later cannot forget to do it.
   */
  private emit(event: AgentRunEvent): void {
    this.queue.push(this.spec.guardrails.redactSecrets ? redactEvent(event) : event);
  }

  private cleanup(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.opts.signal?.removeEventListener('abort', this.onExternalAbort);
  }

  private readonly onExternalAbort = (): void => {
    this.externallyAborted = true;
    this.abort.abort(new HuskError('E_ABORTED', 'the caller aborted this run'));
  };

  private async drive(): Promise<void> {
    // One controller for the whole run: the caller's signal, our own deadline and
    // an abandoned stream all land here, and it is handed to the model request
    // and to every tool call, so both actually stop rather than merely losing a
    // race against a timer.
    if (this.opts.signal?.aborted) this.onExternalAbort();
    else this.opts.signal?.addEventListener('abort', this.onExternalAbort, { once: true });

    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.abort.abort(new HuskError('E_ABORTED', 'the run hit its time limit'));
    }, this.budget.limits.timeoutMs);
    this.timer.unref?.();

    this.emit({ type: 'run_start', runId: this.runId, husk: this.spec.name, model: this.model });

    // A husk that needs tools cannot run on a model that has none.
    //
    // Not every local model does tool calling -- gemma3, for one, reports only
    // `vision` -- and without this check the run burns minutes of local
    // inference, then fails with the model narrating what it would have done.
    // Better to say so before the first token.
    if (this.toolsByName.size > 0 && this.router.getModelInfo) {
      const info = await this.router.getModelInfo(this.model).catch(() => undefined);
      if (info && info.supportsTools === false) {
        const err = {
          message: `${info.id} cannot call tools, and this husk declares ${this.toolsByName.size}`,
          code: 'E_MODEL_UNAVAILABLE',
        };
        this.emit({ type: 'error', error: err });
        this.emit({ type: 'run_end', result: this.result('error', err) });
        this.queue.end();
        return;
      }
    }

    for (const example of this.spec.examples) {
      this.messages.push({ role: 'user', content: example.user });
      this.messages.push({ role: 'assistant', content: example.assistant });
    }
    if (this.opts.history?.length) this.messages.push(...this.opts.history);
    if (typeof this.opts.input === 'string') this.messages.push({ role: 'user', content: this.opts.input });
    else this.messages.push(...this.opts.input);

    let stop: RunResult['stopReason'] = 'complete';
    let error: RunResult['error'];

    try {
      const outcome = await this.loop();
      stop = outcome.stopReason;
      error = outcome.error;
    } catch (err) {
      const he = err instanceof HuskError ? err : undefined;
      if (this.timedOut) {
        stop = 'timeout';
        error = { message: 'the run hit its time limit', code: 'E_ABORTED' };
      } else if (this.externallyAborted || he?.code === 'E_ABORTED') {
        stop = 'aborted';
        error = { message: (err as Error).message, code: 'E_ABORTED' };
      } else {
        stop = 'error';
        error = { message: (err as Error).message, code: he?.code };
        this.emit({ type: 'error', error });
      }
    }

    this.emit({ type: 'run_end', result: this.result(stop, error) });
    this.queue.end();
  }

  private result(stopReason: RunResult['stopReason'], error?: RunResult['error']): RunResult {
    return {
      runId: this.runId,
      text: this.finalText,
      messages: this.messages,
      steps: this.budget.steps,
      usage: this.budget.snapshot(),
      durationMs: Date.now() - this.startedAt,
      stopReason,
      error,
      trace: this.trace,
    };
  }

  private async loop(): Promise<{ stopReason: RunResult['stopReason']; error?: RunResult['error'] }> {
    for (;;) {
      if (this.abort.signal.aborted) return { stopReason: this.timedOut ? 'timeout' : 'aborted' };

      await this.maybeTrim();
      await this.resolvePricing();

      const estimate = this.budget.estimate(this.estimatePromptTokens(), ASSUMED_OUTPUT_TOKENS);
      const decision = this.budget.check(estimate);
      if (!decision.ok) {
        this.emit({ type: 'warning', message: `stopping: ${decision.reason}` });
        return {
          stopReason: decision.stopReason ?? 'budget',
          error: { message: decision.reason ?? 'out of budget', code: 'E_BUDGET_EXCEEDED' },
        };
      }

      const step = this.budget.beginStep();
      this.emit({ type: 'step_start', step });

      const response = await this.callModel();
      this.trace.push(response);
      this.budget.record(response.usage);
      this.emit({ type: 'usage', usage: response.usage, cumulative: this.budget.snapshot() });

      const assistant = buildAssistantMessage(response);
      this.messages.push(assistant);
      this.emit({ type: 'message', message: assistant });
      if (response.text.trim()) this.finalText = response.text;

      if (!response.toolCalls.length) return { stopReason: 'complete' };

      const repetition = this.trackRepetition(response.toolCalls);
      if (repetition === 'stop') {
        return {
          stopReason: 'error',
          error: {
            message:
              `stopped: ${response.toolCalls[0]?.name ?? 'a tool'} was called with byte-identical arguments ` +
              `${REPEAT_STOP_AT} times in a row`,
            code: 'E_TOOL_ERROR',
          },
        };
      }

      const results = await this.runToolCalls(response.toolCalls);
      this.messages.push({ role: 'tool', content: results });

      if (repetition === 'nudge') {
        const name = response.toolCalls[0]?.name ?? 'that tool';
        this.messages.push({
          role: 'user',
          content:
            `[husk] You have called ${name} with byte-identical arguments ${REPEAT_NUDGE_AT} times in a row and the ` +
            `result is not changing. Do something different: change the arguments, use another tool, or tell the ` +
            `user what is blocking you.`,
        });
      }

      if (this.abort.signal.aborted) return { stopReason: this.timedOut ? 'timeout' : 'aborted' };
    }
  }

  private async resolvePricing(): Promise<void> {
    if (this.pricingResolved) return;
    this.pricingResolved = true;
    if (!this.router.getModelInfo) return;
    try {
      this.budget.setPricing(pricingOf(await this.router.getModelInfo(this.model)));
    } catch (err) {
      this.log.debug(`could not price ${this.model}`, err);
    }
  }

  private estimatePromptTokens(): number {
    let n = estimateTokens(this.system);
    for (const m of this.messages) {
      n += estimateTokens(messageText(m));
      if (typeof m.content === 'string') continue;
      for (const part of m.content) {
        if (part.type === 'tool_call') n += estimateTokens(part.name + JSON.stringify(part.args));
      }
    }
    for (const t of this.toolsByName.values()) {
      n += estimateTokens(t.name + t.description + JSON.stringify(t.parameters));
    }
    return n;
  }

  private toolSchemas(): ToolSchema[] {
    return [...this.toolsByName.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * One real token stream per step.
   *
   * Deltas are forwarded as they arrive rather than synthesised after the fact;
   * the accumulated parts are only used when a provider ends without `done`.
   */
  private async callModel(): Promise<ChatResponse> {
    const schemas = this.toolSchemas();
    const req: ChatRequest = {
      model: this.model,
      messages: this.messages,
      system: this.system || undefined,
      tools: schemas.length ? schemas : undefined,
      temperature: this.spec.temperature,
      signal: this.abort.signal,
      metadata: { huskId: this.spec.name, runId: this.runId },
    };

    let text = '';
    let thinking = '';
    const toolCalls: ToolCallPart[] = [];
    let usage: Usage | undefined;
    let done: ChatResponse | undefined;
    let streamError: { message: string; code?: string } | undefined;
    const startedAt = Date.now();

    for await (const event of this.router.stream(req)) {
      switch (event.type) {
        case 'text_delta':
          text += event.text;
          this.emit({ type: 'text_delta', text: event.text });
          break;
        case 'thinking_delta':
          thinking += event.text;
          this.emit({ type: 'thinking_delta', text: event.text });
          break;
        case 'tool_call':
          toolCalls.push(event.call);
          break;
        case 'usage':
          usage = event.usage;
          break;
        case 'done':
          done = event.response;
          break;
        case 'error':
          // The router owns fallback for E_MODEL_UNAVAILABLE and 429. Retrying on
          // top of it would multiply the backoff, so we surface and move on.
          streamError = event.error;
          this.emit({ type: 'warning', message: `model: ${event.error.message}` });
          break;
        default:
          break;
      }
    }

    if (done) return done;
    if (streamError && !text && !toolCalls.length) {
      throw new HuskError(
        streamError.code === 'E_MODEL_UNAVAILABLE' ? 'E_MODEL_UNAVAILABLE' : 'E_MODEL_ERROR',
        streamError.message,
        { hint: 'run `husk doctor` to see which models are reachable' },
      );
    }

    return {
      model: this.model,
      text,
      thinking: thinking || undefined,
      toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage: usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latencyMs: Date.now() - startedAt,
    };
  }

  private trackRepetition(calls: ToolCallPart[]): 'ok' | 'nudge' | 'stop' {
    const signature = calls.map((c) => `${c.name}:${stableArgs(c.args)}`).join('|');
    if (signature === this.lastSignature) {
      this.repeatCount += 1;
    } else {
      this.lastSignature = signature;
      this.repeatCount = 1;
    }
    if (this.repeatCount >= REPEAT_STOP_AT) {
      this.emit({
        type: 'warning',
        message: `stopping: ${calls[0]?.name ?? 'a tool'} repeated ${this.repeatCount} times without progress`,
      });
      return 'stop';
    }
    if (this.repeatCount === REPEAT_NUDGE_AT) {
      this.emit({
        type: 'warning',
        message: `${calls[0]?.name ?? 'a tool'} has repeated ${this.repeatCount} times; nudging the model`,
      });
      return 'nudge';
    }
    return 'ok';
  }

  /**
   * Run one turn's tool calls concurrently, append them in the model's order.
   *
   * `mapLimit` preserves input order regardless of completion order, so a fast
   * second call cannot overtake a slow first one in the transcript. Anything
   * else makes a run unreproducible.
   */
  private runToolCalls(calls: ToolCallPart[]): Promise<ToolResultPart[]> {
    return mapLimit(calls, TOOL_CONCURRENCY, (call) => this.runOneTool(call));
  }

  private async runOneTool(call: ToolCallPart): Promise<ToolResultPart> {
    const startedAt = Date.now();
    this.emit({ type: 'tool_start', call });

    const finish = (content: string, isError: boolean): ToolResultPart => {
      const safe = this.sanitise(content);
      this.emit({ type: 'tool_end', call, output: safe, isError, durationMs: Date.now() - startedAt });
      return { type: 'tool_result', toolCallId: call.id, content: safe, isError };
    };

    const deny = (reason: string): ToolResultPart => {
      this.emit({ type: 'tool_denied', call, reason });
      return finish(`Denied: ${reason}`, true);
    };

    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      const known = [...this.toolsByName.keys()].join(', ') || 'none';
      return finish(`Error: no tool named "${call.name}". Available tools: ${known}.`, true);
    }

    if (tool.dangerous) {
      if (this.approvalMode === 'readonly') {
        return deny(`${tool.name} can change state and this run is in readonly mode`);
      }
      if (this.approvalMode === 'ask') {
        if (!this.opts.onApproval) {
          // No approver means nobody said yes. Defaulting to allow here would
          // make `ask` mode a comment rather than a control.
          return deny(`${tool.name} needs approval and no approver is wired to this run`);
        }
        const approved = await this.askApproval({
          runId: this.runId,
          huskId: this.spec.name,
          tool: tool.name,
          args: call.args,
          prompt: `Allow ${tool.name}?`,
          details: call.args,
          dangerous: true,
        });
        if (!approved) return deny(`the operator declined ${tool.name}`);
      }
    }

    try {
      const output = await tool.handler(call.args, this.toolContext(call));
      return finish(tool.render ? tool.render(output) : stringify(output), false);
    } catch (err) {
      if (this.abort.signal.aborted) {
        return finish(this.timedOut ? 'Error: the run ran out of time.' : 'Error: the run was aborted.', true);
      }
      const he = err instanceof HuskError ? err : undefined;
      const message = he ? `${he.message}${he.hint ? `\nHint: ${he.hint}` : ''}` : (err as Error).message;
      this.log.debug(`tool ${call.name} failed`, err);
      return finish(`Error: ${message}`, true);
    }
  }

  private async askApproval(req: ApprovalRequest): Promise<boolean> {
    const approver = this.opts.onApproval;
    if (!approver) return false;
    try {
      return (await approver(req)) === true;
    } catch (err) {
      this.log.warn('the approver threw; treating that as a refusal', err);
      return false;
    }
  }

  /** Clamp first so redaction runs over bounded input, then strip credentials. */
  private sanitise(text: string): string {
    const clamped = clampText(text, this.spec.limits.maxOutputBytes);
    return this.spec.guardrails.redactSecrets ? redact(clamped.text) : clamped.text;
  }

  private toolContext(call: ToolCallPart): AgentToolContext {
    return {
      computer: this.computer,
      log: this.log.child(call.name),
      signal: this.abort.signal,
      huskId: this.spec.name,
      runId: this.runId,
      state: this.state,
      emit: (event: AgentRunEvent) => this.emit(event),
      confirm: (prompt: string, details?: Record<string, unknown>) => {
        if (this.approvalMode === 'auto') return Promise.resolve(true);
        if (this.approvalMode === 'readonly') return Promise.resolve(false);
        return this.askApproval({
          runId: this.runId,
          huskId: this.spec.name,
          tool: call.name,
          args: call.args,
          prompt,
          details,
          dangerous: true,
        });
      },
      acquireComputer: () => this.acquireComputer(),
      spec: this.spec,
      maxOutputBytes: this.spec.limits.maxOutputBytes,
      callId: call.id,
    };
  }

  /**
   * Bring the machine up on first use.
   *
   * Memoised on the promise, not the result, so four parallel tool calls in one
   * turn share one container instead of racing into four.
   */
  private acquireComputer(): Promise<Computer> {
    if (this.computerPromise) return this.computerPromise;

    const source = this.computers;
    if (!source || !this.spec.computer.enabled) {
      return Promise.reject(
        new HuskError('E_COMPUTER_NOT_FOUND', `the husk "${this.spec.name}" has no computer`, {
          hint: this.spec.computer.enabled
            ? 'construct the Agent with a `computers` source, such as a ComputerManager from @husk/runtime'
            : 'set computer.enabled to true in husk.yaml',
        }),
      );
    }

    const pending = (async () => {
      const computer = await source.ensure(this.deps.computerKey, this.computerSpec());
      this.computer = computer;
      this.emit({ type: 'computer_ready', computerId: computer.id, provider: computer.info.provider });
      return computer;
    })();

    this.computerPromise = pending.catch((err: unknown) => {
      // A failed boot must not poison the whole run; the next call may retry.
      this.computerPromise = undefined;
      throw err;
    });

    return this.computerPromise;
  }

  private computerSpec(): ComputerSpec {
    return computerSpecFor(this.spec);
  }

  private async maybeTrim(): Promise<void> {
    if (!this.spec.memory.enabled) return;
    const trimmed = await trimHistory(this.messages, {
      windowTurns: this.spec.memory.windowTurns,
      summarise: this.spec.memory.summarise,
      summariser: (slice) => this.summarise(slice),
      onWarning: (message) => this.emit({ type: 'warning', message }),
    });
    if (!trimmed.elided) return;
    this.messages.length = 0;
    this.messages.push(...trimmed.messages);
    this.emit({
      type: 'warning',
      message: `trimmed ${trimmed.elided} earlier messages${trimmed.summarised ? ' into a summary' : ''}`,
    });
  }

  private async summarise(slice: ModelMessage[]): Promise<string | null> {
    const response = await this.router.chat({
      model: this.deps.summaryModel ?? this.model,
      system:
        'Summarise this slice of an agent transcript in at most 200 words. Keep decisions, file paths, commands ' +
        'that worked, and anything still outstanding. Drop pleasantries.',
      messages: [{ role: 'user', content: renderForSummary(slice) }],
      maxTokens: 400,
      signal: this.abort.signal,
    });
    this.budget.record(response.usage);
    return response.text.trim() || null;
  }
}

/**
 * `husk.yaml`'s `computer:` block as a `ComputerSpec`.
 *
 * The only translation between the file a user writes and the spec a provider
 * receives, so it is a free function rather than a private method: a test can
 * prove that a label set in a husk.yaml is the same label `resolveSshSettings`
 * reads, without booting an agent to find out.
 */
export function computerSpecFor(spec: HuskSpec): ComputerSpec {
  const c = spec.computer;
  return {
    name: spec.name,
    provider: c.provider,
    image: c.image,
    flavor: c.flavor,
    cpus: c.cpus,
    memoryMb: c.memoryMb,
    diskMb: c.diskMb,
    idleTimeoutSec: c.idleTimeoutSec,
    maxLifetimeSec: c.maxLifetimeSec,
    network: c.network,
    env: c.env,
    mounts: c.mounts,
    workdir: c.workdir,
    persist: c.persist,
    packages: c.packages,
    setup: c.setup,
    user: c.user,
    labels: c.labels,
  };
}

/**
 * Text, thinking and tool calls in ONE assistant message.
 *
 * The previous loop wrote `content: res.text || res.toolCalls`, which discarded
 * every tool call the model made whenever it also said something -- and models
 * say something most of the time.
 */
export function buildAssistantMessage(response: ChatResponse): ModelMessage {
  const parts: ContentPart[] = [];
  if (response.thinking) parts.push({ type: 'thinking', text: response.thinking });
  if (response.text) parts.push({ type: 'text', text: response.text });
  for (const call of response.toolCalls) parts.push(call);
  if (!parts.length) return { role: 'assistant', content: '' };
  return { role: 'assistant', content: parts };
}

/** Byte-stable rendering of tool arguments, so key order cannot hide a repeat. */
export function stableArgs(args: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(args));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

function stringify(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '(no output)';
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}
