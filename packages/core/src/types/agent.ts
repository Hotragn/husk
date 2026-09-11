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
}

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
