/**
 * @husk-ai/core/contracts -- the browser-safe half of core.
 *
 * Errors, types, spec parsing and pure helpers: nothing here touches a Node
 * built-in or `process`, so a browser bundle (the console, anything built on
 * `@husk-ai/sdk`) can import it as is. The Node-only modules -- ids, logger,
 * util, audit, config -- are exported from the main entry only.
 */

export * from './errors.js';
export * from './lifecycle.js';
export * from './spec.js';
export * from './net.js';
export * from './browse.js';
export * from './computer-info.js';
export * from './windows-shell.js';
export * from './identity.js';
export * from './chat-identity.js';


export type {
  ProviderName,
  ComputerState,
  NetworkPolicy,
  MountSpec,
  Flavor,
  ComputerSpec,
  ComputerInfo,
  PortBinding,
  ExecRequest,
  ExecResult,
  DirEntry,
  WriteFileOptions,
  Computer,
  Availability,
  ComputerProvider,
} from './types/computer.js';

export type {
  Role,
  TextPart,
  ImagePart,
  ToolCallPart,
  ToolResultPart,
  ThinkingPart,
  ContentPart,
  ModelMessage,
  JSONSchema,
  ToolSchema,
  ToolChoice,
  ChatRequest,
  Usage,
  FinishReason,
  ChatResponse,
  StreamEvent,
  ModelInfo,
  ModelProvider,
} from './types/model.js';
export { messageText } from './types/model.js';

export type {
  ToolContext,
  Tool,
  ApprovalMode,
  ApprovalRequest,
  Approver,
  HandoffOutcome,
  HandoffRequest,
  RunOptions,
  RunEvent,
  RunResult,
} from './types/agent.js';

export type {
  TranscriptSource,
  TranscriptMessage,
  Transcript,
  ImportInput,
  TranscriptImporter,
  DistilledAgent,
} from './types/transcript.js';

