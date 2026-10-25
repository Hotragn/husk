import { livePageFor } from '@husk-ai/browser';
import { HuskError, isHuskError } from '@husk-ai/core';
import type {
  ApprovalRequest,
  Computer,
  HandoffRequest,
  ComputerSpec,
  HuskSpec,
  ModelMessage,
  RunEvent,
  RunResult,
  ToolCallPart,
} from '@husk-ai/core';
import { ApprovalRegistry } from './approvals.js';
import { admitCall } from './control.js';
import type { PendingApproval } from './approvals.js';
import { HandoffRegistry } from './handoffs.js';
import type { PendingHandoff } from './handoffs.js';
import type { ComputerSourceLike, ManagerLike, ResolvedDeps, ServerRunOptions } from './deps.js';
import { EventBus } from './events.js';
import { huskError } from './errors.js';
import type { RunSummary } from './store.js';

/** What `POST /v1/husks/:name/run` accepts. */
export interface RunRequestBody {
  input?: string | ModelMessage[];
  history?: ModelMessage[];
  model?: string;
  vars?: Record<string, string>;
  maxSteps?: number;
  maxCostUsd?: number;
  approvalMode?: 'auto' | 'ask' | 'readonly';
  /**
   * Pin this run to a computer that already exists.
   *
   * This was documented for months as accepted-and-ignored, on the reasoning
   * that the agent addresses machines by a stable *key* rather than by id, so
   * honouring it would mean widening a `@husk-ai/agent` contract. It does not:
   * `ComputerSource` is an interface with one method, and a source that answers
   * every key with one particular machine satisfies it exactly. See
   * {@link pinnedSource}.
   *
   * What it is for: a machine you set up by hand -- a checkout, a dataset, a
   * logged-in browser profile -- and want a run to land in rather than getting
   * a fresh one.
   */
  computerId?: string;
}

/**
 * A `ComputerSource` that always hands back the same machine.
 *
 * The agent asks for a computer by key so one conversation keeps one machine
 * across turns. When the caller has already named a machine by id, every key
 * should resolve to it -- including the spec-derived key the agent would
 * otherwise have used to create a second one.
 *
 * The spec the agent passes is deliberately dropped: the machine exists, its
 * shape is already decided, and quietly re-creating it to match a spec would
 * destroy the state that was the reason for pinning in the first place.
 */
function pinnedSource(computer: Computer): ComputerSourceLike {
  return { ensure: async () => computer };
}

/**
 * Core owns `approval_required` now, so the wire event is just a `RunEvent`.
 * The alias remains because every signature in this file already names it.
 */
export type ApprovalRequiredEvent = Extract<RunEvent, { type: 'approval_required' }>;

export type ServerRunEvent = RunEvent;

interface ActiveRun {
  runId: string;
  husk: string;
  abort: AbortController;
  startedAt: number;
  /** What the run is doing now, from its own events, for the computers overview. */
  computerId?: string;
  step?: number;
  /** Tool calls in flight, by call id: a turn's calls run concurrently. */
  tools?: Map<string, string>;
}

/** One running run, as the overview shows it. */
export interface ActiveRunInfo {
  runId: string;
  husk: string;
  startedAt: string;
  computerId?: string;
  step?: number;
  tool?: string;
}

export interface RunnerOptions {
  approvalTimeoutMs?: number;
}

/**
 * Owns the lifecycle of a run: id assignment, persistence, approvals, cancellation.
 *
 * The control plane assigns the run id rather than adopting the agent's. The agent
 * mints its own id inside `run()` and there is no way to pass one in, so adopting it
 * would mean the id in `run_start` is unknown to `/v1/runs/:id/cancel` until the
 * first event lands. Rewriting the id on the two events that carry it keeps one id
 * true everywhere -- in the stream, in the store, and in the cancel call.
 */
export class Runner {
  readonly approvals: ApprovalRegistry;
  readonly handoffs: HandoffRegistry;
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly deps: ResolvedDeps,
    private readonly bus: EventBus,
    opts: RunnerOptions = {},
  ) {
    this.approvals = new ApprovalRegistry(
      opts.approvalTimeoutMs === undefined ? {} : { timeoutMs: opts.approvalTimeoutMs },
    );
    this.handoffs = new HandoffRegistry(deps.holdsFile);
  }

  get activeCount(): number {
    return this.active.size;
  }

  listActive(): ActiveRunInfo[] {
    return [...this.active.values()].map((r) => ({
      runId: r.runId,
      husk: r.husk,
      startedAt: new Date(r.startedAt).toISOString(),
      ...(r.computerId ? { computerId: r.computerId } : {}),
      ...(r.step !== undefined ? { step: r.step } : {}),
      ...(r.tools?.size ? { tool: [...new Set(r.tools.values())].join(', ') } : {}),
    }));
  }

  /** Keep the active run's computer, step and current tool up to date. */
  private track(runId: string, e: ServerRunEvent): void {
    const run = this.active.get(runId);
    if (!run) return;
    if (e.type === 'computer_ready') run.computerId = e.computerId;
    else if (e.type === 'step_start') run.step = e.step;
    else if (e.type === 'tool_start') (run.tools ??= new Map()).set(e.call.id, e.call.name);
    else if (e.type === 'tool_end' || e.type === 'tool_denied') run.tools?.delete(e.call.id);
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    run.abort.abort(new HuskError('E_ABORTED', 'run cancelled by the operator'));
    return true;
  }

  cancelAll(reason = 'server shutting down'): number {
    const n = this.active.size;
    for (const run of this.active.values()) run.abort.abort(new HuskError('E_ABORTED', reason));
    this.approvals.denyAll();
    this.handoffs.denyAll();
    return n;
  }

  private buildOptions(
    spec: HuskSpec,
    body: RunRequestBody,
    runId: string,
    signal: AbortSignal,
    onEvent: (e: ServerRunEvent) => void,
  ): ServerRunOptions {
    if (body.input === undefined || body.input === null || body.input === '') {
      throw huskError('E_SPEC_INVALID', 'run requires a non-empty `input`', {
        hint: 'POST { "input": "your prompt" } or an array of ModelMessage',
      });
    }
    const approvalMode = body.approvalMode ?? spec.guardrails.approvalMode;
    const opts: ServerRunOptions = {
      input: body.input,
      maxSteps: body.maxSteps ?? spec.limits.maxSteps,
      // The server's ceiling wins over the husk's: a husk file is user data.
      maxCostUsd: Math.min(body.maxCostUsd ?? spec.limits.maxCostUsd, spec.limits.maxCostUsd),
      maxTokens: spec.limits.maxTokens,
      timeoutSec: spec.limits.timeoutSec,
      approvalMode,
      signal,
      onEvent,
    };
    if (body.history) opts.history = body.history;
    if (body.model) opts.model = body.model;
    if (body.vars) opts.vars = body.vars;
    // Not gated on approval mode: a handoff pauses the run, it does not act on
    // the machine, so there is nothing for an approver to decide.
    opts.onHandoff = async (request: HandoffRequest, runSignal: AbortSignal) => {
      // Nobody may be watching yet, and the browser closes itself after five idle
      // minutes. The login form the person is coming to fill in has to still be there.
      const computerId = request.computerId;
      const keepAlive = computerId ? setInterval(() => livePageFor(computerId), 60_000) : undefined;
      keepAlive?.unref?.();
      try {
        return await this.handoffs.request(
          { runId, husk: spec.name, reason: request.reason, ...(computerId ? { computerId } : {}), signal: runSignal },
          (pending: PendingHandoff) => {
            onEvent({ type: 'handoff_required', request });
            this.bus.emit('runs', 'handoff_required', pending);
          },
        );
      } finally {
        if (keepAlive) clearInterval(keepAlive);
      }
    };
    // The run's tools obey a person holding its computer, as a chat's do:
    // refused while they hold it, stopped part-way when they take it.
    opts.admitTool = (call, runSignal) => {
      const computerId = this.active.get(runId)?.computerId;
      if (!computerId) return Promise.resolve({ signal: runSignal, done: () => {}, stopped: () => undefined });
      return admitCall(this.handoffs, computerId, call.name, runSignal);
    };
    if (approvalMode === 'ask') {
      opts.onApproval = (request: ApprovalRequest) => {
        // The approval queue is keyed on a tool call; a free-form ctx.confirm has
        // no real call, so it gets a synthetic one rather than a separate path.
        const call: ToolCallPart = {
          type: 'tool_call',
          id: request.callId ?? `confirm_${runId}`,
          name: request.tool ?? 'confirm',
          args: request.args ?? {},
        };
        return this.approvals.request({ runId, husk: spec.name, call, signal }, (pending: PendingApproval) => {
          onEvent({ type: 'approval_required', approvalId: pending.approvalId, request });
          this.bus.emit('runs', 'approval_required', pending);
        });
      };
    }
    return opts;
  }

  /** The agent assigns its own run id; the control plane's id is the one that counts. */
  private normalise(event: RunEvent, runId: string): ServerRunEvent {
    if (event.type === 'run_start') return { ...event, runId };
    if (event.type === 'run_end') return { ...event, result: { ...event.result, runId } };
    return event;
  }

  private async begin(spec: HuskSpec, body: RunRequestBody): Promise<{ runId: string; model: string }> {
    const runId = this.deps.store.newRunId();
    const model = body.model ?? spec.model;
    await this.deps.store.startRun({
      runId,
      husk: spec.name,
      model,
      startedAt: new Date(this.deps.now()).toISOString(),
    });
    await this.deps.store.bumpRunCount(spec.name);
    this.bus.emit('runs', 'run_started', { runId, husk: spec.name, model });
    return { runId, model };
  }

  private async end(runId: string, husk: string, model: string, result: RunResult): Promise<RunSummary> {
    const summary = await this.deps.store.finishRun(runId, { ...result, runId }, husk, model);
    this.bus.emit('runs', 'run_finished', summary);
    return summary;
  }

  private failureResult(runId: string, err: unknown, startedAt: number): RunResult {
    const aborted = isHuskError(err) && err.code === 'E_ABORTED';
    return {
      runId,
      text: '',
      messages: [],
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      durationMs: this.deps.now() - startedAt,
      stopReason: aborted ? 'aborted' : 'error',
      error: {
        message: err instanceof Error ? err.message : String(err),
        ...(isHuskError(err) ? { code: err.code } : {}),
      },
    };
  }

  /** Non-streaming run. Events are still persisted, so `/v1/runs/:id` is complete. */
  async run(spec: HuskSpec, body: RunRequestBody, outerSignal?: AbortSignal): Promise<RunResult> {
    const { runId, model } = await this.begin(spec, body);
    const abort = new AbortController();
    const startedAt = this.deps.now();
    outerSignal?.addEventListener('abort', () => abort.abort(outerSignal.reason), { once: true });
    this.active.set(runId, { runId, husk: spec.name, abort, startedAt });

    const events: ServerRunEvent[] = [];
    const collect = (e: ServerRunEvent) => {
      events.push(e);
      this.track(runId, e);
    };

    try {
      const agent = await this.deps.agentFactory({
        spec,
        router: this.deps.router,
        computers: await this.computerSource(body),
      });
      const opts = this.buildOptions(spec, body, runId, abort.signal, (e) =>
        collect(e.type === 'approval_required' ? e : this.normalise(e as RunEvent, runId)),
      );
      const result = await agent.run(opts);
      const finalResult: RunResult = { ...result, runId };
      await this.persistEvents(runId, events);
      await this.end(runId, spec.name, model, finalResult);
      return finalResult;
    } catch (err) {
      const failed = this.failureResult(runId, err, startedAt);
      await this.persistEvents(runId, events);
      await this.end(runId, spec.name, model, failed);
      throw err;
    } finally {
      this.active.delete(runId);
    }
  }


  /**
   * The `ComputerSource` for this run: pinned, or the manager as usual.
   *
   * Resolved once per run rather than per `ensure` call, so a bad id fails
   * before the model is billed for a single token.
   */
  private async computerSource(body: RunRequestBody): Promise<ManagerLike | ComputerSourceLike> {
    if (!body.computerId) return this.deps.manager;
    const computer = await this.deps.manager.get(body.computerId);
    if (!computer) {
      throw huskError('E_COMPUTER_NOT_FOUND', `no computer with id ${body.computerId}`, {
        hint: 'list them with `GET /v1/computers`, or omit computerId to let the husk bring up its own',
      });
    }
    return pinnedSource(computer);
  }

  /**
   * Streaming run.
   *
   * The returned iterable is what the SSE layer pumps. Aborting `signal` -- which is
   * what a disconnected SSE client does -- aborts the agent, so a closed browser tab
   * stops spending tokens instead of running to completion unseen.
   */
  async *stream(spec: HuskSpec, body: RunRequestBody, signal: AbortSignal): AsyncGenerator<ServerRunEvent> {
    const { runId, model } = await this.begin(spec, body);
    const abort = new AbortController();
    const startedAt = this.deps.now();
    if (signal.aborted) abort.abort(signal.reason);
    signal.addEventListener('abort', () => abort.abort(signal.reason), { once: true });
    this.active.set(runId, { runId, husk: spec.name, abort, startedAt });

    // The agent reports approvals and warnings through `onEvent` rather than the
    // iterator, so side-channel events are queued and interleaved here.
    const sideChannel: ServerRunEvent[] = [];
    const written: ServerRunEvent[] = [];
    let last: RunResult | undefined;

    const record = (e: ServerRunEvent) => {
      written.push(e);
      this.track(runId, e);
      if (e.type === 'run_end') last = e.result;
    };

    try {
      const agent = await this.deps.agentFactory({
        spec,
        router: this.deps.router,
        computers: await this.computerSource(body),
      });
      // Approvals and handoffs pause the agent inside a tool call, so the event
      // that says so cannot wait for the agent's next event: it would arrive only
      // once the person had already answered. Wake the loop as soon as one lands.
      let wake: (() => void) | undefined;
      const opts = this.buildOptions(spec, body, runId, abort.signal, (e) => {
        if (e.type === 'approval_required' || e.type === 'handoff_required') {
          sideChannel.push(e);
          wake?.();
        }
      });

      const events = agent.stream(opts)[Symbol.asyncIterator]();
      for (;;) {
        const next = events.next();
        let step: IteratorResult<RunEvent> | undefined;
        for (;;) {
          // Asking for the next event can itself raise one synchronously, before
          // there is anything to wake, so drain what is queued before waiting.
          while (sideChannel.length) {
            const side = sideChannel.shift()!;
            record(side);
            yield side;
          }
          if (step) break;
          const woken = new Promise<undefined>((resolve) => {
            wake = () => resolve(undefined);
          });
          step = await Promise.race([next, woken]);
          wake = undefined;
        }
        if (step.done) break;
        const event = this.normalise(step.value, runId);
        record(event);
        yield event;
      }

      const result = last ?? this.failureResult(runId, new Error('agent stream ended without a run_end'), startedAt);
      await this.persistEvents(runId, written);
      await this.end(runId, spec.name, model, { ...result, runId });
    } catch (err) {
      const failed = this.failureResult(runId, err, startedAt);
      const errorEvent: RunEvent = { type: 'error', error: failed.error ?? { message: 'run failed' } };
      record(errorEvent);
      await this.persistEvents(runId, written);
      await this.end(runId, spec.name, model, failed);
      if (!abort.signal.aborted) throw err;
    } finally {
      this.active.delete(runId);
    }
  }

  private async persistEvents(runId: string, events: ServerRunEvent[]): Promise<void> {
    for (const e of events) await this.deps.store.appendEvent(runId, e as RunEvent);
  }
}
