import type { Approver } from '@husk-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  Computer,
  ComputerSpec,
  HuskSpec,
  JSONSchema,
  Logger,
  ModelInfo,
  RunEvent,
  RunOptions,
  StreamEvent,
  Tool,
  ToolContext,
} from '@husk-ai/core';

/**
 * The model surface this package needs, declared structurally.
 *
 * `@husk-ai/agent` depends on `@husk-ai/core` and nothing else in the workspace, so the
 * router is handed in rather than imported. `@husk-ai/models`' ModelRouter satisfies
 * this shape; so does a twenty-line fake in a test.
 */
export interface RouterLike {
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  /** Optional. When present the budget can price a call *before* making it. */
  getModelInfo?(model: string): Promise<ModelInfo | null>;
}

/** The computer surface this package needs. `ComputerManager` satisfies it. */
export interface ComputerSource {
  ensure(key: string, spec?: ComputerSpec): Promise<Computer>;
}

/**
 * Incremental output from a long-running tool.
 *
 * `RunEvent` in @husk-ai/core has no way to say "this shell command printed a line",
 * and `text_delta` belongs to the model's own token stream. Rather than corrupt
 * that stream we add one member here and report the gap upstream.
 */
export interface ToolDeltaEvent {
  type: 'tool_delta';
  callId: string;
  tool: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export type AgentRunEvent = RunEvent | ToolDeltaEvent;

// The canonical shape lives in core so the server and the CLI agree with the loop.
export type { ApprovalRequest, Approver } from '@husk-ai/core';


export interface AgentRunOptions extends RunOptions {
  /**
   * Called before any dangerous tool runs in `ask` mode.
   * When absent the call is DENIED -- approval is a security boundary, and a
   * missing approver means nobody said yes.
   */
  onApproval?: Approver;
  onEvent?: (event: AgentRunEvent) => void;
}

/** What the built-in tools get, on top of the core contract. */
export interface AgentToolContext extends ToolContext {
  computer?: Computer;
  /**
   * Materialise the machine, creating it on first use so a husk that never
   * touches the shell never pays for a container.
   */
  acquireComputer(): Promise<Computer>;
  emit(event: AgentRunEvent): void;
  spec: HuskSpec;
  /** Byte ceiling the loop will clamp this tool's output to anyway. */
  maxOutputBytes: number;
  /** The tool call currently executing, for correlating `tool_delta`. */
  callId: string;
}

export interface AgentTool<I = Record<string, unknown>, O = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema;
  dangerous?: boolean;
  optIn?: boolean;
  /** The tool cannot function without a machine; resolveTools skips it when none exists. */
  needsComputer?: boolean;
  handler(input: I, ctx: AgentToolContext): Promise<O>;
  render?(output: O): string;
}

/**
 * Erase a tool's input/output types so heterogeneous tools share one array,
 * while each definition keeps full checking inside its own handler.
 */
export function defineTool<I extends Record<string, unknown>, O>(tool: AgentTool<I, O>): AgentTool {
  return tool as unknown as AgentTool;
}

/** Every `AgentTool` is a valid core `Tool`; the loop always supplies the richer context. */
export function asTools(tools: AgentTool[]): Tool[] {
  return tools as unknown as Tool[];
}

export interface AgentOptions {
  spec: HuskSpec;
  router: RouterLike;
  computers?: ComputerSource;
  /** Overrides the tools resolved from `spec.tools`. */
  tools?: Tool[];
  logger?: Logger;
  /**
   * Stable key for `ComputerSource.ensure`, so one conversation keeps one
   * filesystem across runs. Defaults to the husk name.
   */
  computerKey?: string;
  /** Cheap model used to summarise trimmed history. Defaults to the run's model. */
  summaryModel?: string;
  env?: NodeJS.ProcessEnv;
}
