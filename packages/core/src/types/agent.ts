import type { Computer } from './computer.js';
import type { ChatResponse, JSONSchema, ModelMessage, ToolCallPart, Usage } from './model.js';
import type { Logger } from '../logger.js';

export interface ToolContext {
  /** The machine this agent is driving, when it has one. */
  computer?: Computer;
  log: Logger;
  signal?: AbortSignal;
  huskId: string;
  runId: string;
  /** Scratch space shared across tool calls within one run. */
  state: Map<string, unknown>;
  emit(event: RunEvent): void;
  /** Ask the operator to approve a dangerous call. Resolves false when no approver is wired. */
  confirm(prompt: string, details?: Record<string, unknown>): Promise<boolean>;
  /**
   * Stop the run and wait for a person to finish something only they can do.
   * Resolves `done` only when that person says so; `aborted` when the run ends first.
   */
  handoff?(request: HandoffRequest): Promise<HandoffOutcome>;
}

/** What a person is being asked to do, and the run that is waiting on them. */
export interface HandoffRequest {
  runId: string;
  huskId: string;
  /** One sentence a person can act on, e.g. "Sign in to example.com". */
  reason: string;
  /** The machine whose browser the person needs, when the run has one up. */
  computerId?: string;
}

/** `done` is the only way a handoff resumes. Everything else ends the run's wait. */
export type HandoffOutcome = 'done' | 'aborted';

export interface Tool<I = Record<string, unknown>, O = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Requires approval when the run is in ask mode. */
  dangerous?: boolean;
  /** Withheld from the model unless the husk explicitly enables it. */
  optIn?: boolean;
  handler(input: I, ctx: ToolContext): Promise<O>;
  /** Render the result for the model. Defaults to JSON.stringify. */
  render?(output: O): string;
}

export type ApprovalMode = 'auto' | 'ask' | 'readonly';

/**
 * What a human is being asked to approve.
 *
 * Covers both a `dangerous` tool call and a free-form `ctx.confirm`, so an
 * approver written once handles every pause the runtime can raise.
 */
export interface ApprovalRequest {
  runId: string;
  huskId: string;
  /** The tool being called, or undefined for a free-form `ctx.confirm`. */
  tool?: string;
  /** The originating tool call, when there is one. Lets a client correlate. */
  callId?: string;
  args?: Record<string, unknown>;
  /** Human-readable question. Always populated. */
  prompt: string;
  details?: Record<string, unknown>;
  dangerous: boolean;
}

/**
 * Decide whether a paused call may proceed.
 *
 * Returning false, throwing, and not being supplied at all must all deny.
 * Approval is a security boundary: absent means no.
 */
export type Approver = (req: ApprovalRequest) => Promise<boolean>;

/**
 * A tool call a host let in, or why it did not: a refusal (the call does not
 * run), or the signal the call runs under, `done()` once it ends, and
 * `stopped()`, the text for a call a person's take-over cut off.
 */
export type AdmittedTool =
  | { refused: string }
  | { signal: AbortSignal; done(): void; stopped(): string | undefined };

export interface RunOptions {
  input: string | ModelMessage[];
  /** Prior turns to continue from. */
  history?: ModelMessage[];
  model?: string;
  maxSteps?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  timeoutSec?: number;
  approvalMode?: ApprovalMode;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
  /**
   * Called before a `dangerous` tool runs in `ask` mode.
   *
   * Absent means deny. A headless process running an `ask`-mode husk must fail
   * closed, not quietly behave as though it were in `auto`.
   */
  onApproval?: Approver;
  /**
   * Called when the agent hands off to a person. The run stays paused until the
   * promise settles, and `signal` aborts it when the run ends. Absent means the
   * handoff is refused at once: nobody is there to take it, so waiting would hang.
   */
  onHandoff?: (request: HandoffRequest, signal: AbortSignal) => Promise<HandoffOutcome>;
  /**
   * Lets each tool call that acts on the computer in, for a host that shares
   * the computer with a person. Absent means every call runs, as before.
   * `computerId` is the computer the call goes to, once the run has one.
   */
  admitTool?: (call: ToolCallPart, signal: AbortSignal, computerId?: string) => Promise<AdmittedTool>;
  /** Named values interpolated into the persona template. */
  vars?: Record<string, string>;
}

export type RunEvent =
  | { type: 'run_start'; runId: string; husk: string; model: string }
  | { type: 'step_start'; step: number }
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'message'; message: ModelMessage }
  | { type: 'tool_start'; call: ToolCallPart }
  /**
   * Output from a running tool, as it arrives.
   *
   * Deliberately not `text_delta`: that is the model's token stream, and a
   * consumer rendering it must not find a build log spliced into the middle.
   */
  | { type: 'tool_delta'; callId: string; tool: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'tool_end'; call: ToolCallPart; output: string; isError: boolean; durationMs: number }
  | { type: 'tool_denied'; call: ToolCallPart; reason: string }
  /**
   * The run is blocked on a human. Answer by resolving the `Approver`, or over
   * HTTP by POSTing to /v1/approvals/:approvalId. An unanswered request is
   * denied when it times out.
   */
  | { type: 'approval_required'; approvalId: string; request: ApprovalRequest }
  /** The run is waiting on a person. A host that tracks handoffs answers at /v1/handoffs/:handoffId/done. */
  | { type: 'handoff_required'; handoffId: string; request: HandoffRequest }
  | { type: 'computer_ready'; computerId: string; provider: string }
  | { type: 'usage'; usage: Usage; cumulative: Usage }
  | { type: 'warning'; message: string }
  | { type: 'run_end'; result: RunResult }
  | { type: 'error'; error: { message: string; code?: string } };

export interface RunResult {
  runId: string;
  text: string;
  messages: ModelMessage[];
  steps: number;
  usage: Usage;
  durationMs: number;
  /** `loop` means the run was cut short because the agent kept repeating itself. */
  stopReason: 'complete' | 'step_limit' | 'budget' | 'timeout' | 'aborted' | 'loop' | 'error';
  error?: { message: string; code?: string };
  /** Every model call made during the run, for replay and debugging. */
  trace?: ChatResponse[];
}
