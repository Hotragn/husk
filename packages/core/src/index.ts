/**
 * @husk-ai/core -- the contracts.
 *
 * Every other package depends on this one and nothing else in the workspace.
 * If a type belongs to more than one package, it belongs here.
 */

export * from './ids.js';
export * from './errors.js';
export * from './logger.js';
export * from './util.js';
export * from './lifecycle.js';
export * from './audit.js';
export * from './config.js';
export * from './spec.js';
export * from './net.js';
export * from './browse.js';


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

export const HUSK_VERSION = '0.1.0';
