/**
 * Wire shapes for the Husk control plane.
 *
 * Every interface here mirrors what `@husk-ai/server` actually returns, verbatim --
 * including the single-key envelopes (`{ computers: [...] }`). The SDK does not
 * unwrap them: a client that reshapes the wire is a second contract, and two
 * contracts is what broke this package the first time. The document of record is
 * `docs/API.md`; the code of record is `packages/server/src/routes/`.
 */
import type {
  ChatResponse,
  BrowseBody,
  BrowseLink,
  BrowsePage,
  ComputerInfo,
  ComputerSpec,
  ContentPart,
  DirEntry,
  DistilledAgent,
  ExecResult,
  HuskSpec,
  ModelInfo,
  ModelMessage,
  PortBinding,
  RunEvent,
  RunResult,
  StreamEvent,
  ToolCallPart,
  Transcript,
  TranscriptSource,
  Usage,
} from '@husk-ai/core';

// -- health and capability ---------------------------------------------------

/** `GET /health` -- unauthenticated, and *not* under `/v1`. */
export interface HealthReport {
  ok: boolean;
  version: string;
  uptimeSec: number;
}

export interface DoctorProvider {
  name: string;
  description: string;
  priority: number;
  available: boolean;
  /** null when the provider could not be probed at all. */
  isolated: boolean | null;
  /** kernel | machine | guardrails -- what the boundary actually is. */
  isolationKind?: 'kernel' | 'machine' | 'guardrails';
  version?: string;
  reason?: string;
  hint?: string;
}

export interface DoctorModelProvider {
  id: string;
  displayName: string;
  priority: number;
  available: boolean;
  reason?: string;
  hint?: string;
  envKey?: string;
  models: string[];
}

/** `GET /v1/doctor`. Identical to `husk doctor --json` and to the server's own type. */
export interface DoctorReport {
  version: string;
  node: string;
  platform: string;
  huskHome: string;
  firstRun: boolean;
  providers: DoctorProvider[];
  models: DoctorModelProvider[];
  selection: {
    provider: string | null;
    providerReason: string;
    isolated: boolean | null;
    model: string | null;
    modelReason: string;
  };
  warnings: string[];
}

// -- computers ---------------------------------------------------------------

/**
 * `POST /v1/computers` body.
 *
 * The server validates this with a **strict** schema: an unknown key is a 422, not
 * a silently ignored field. That is why this is `ComputerSpec` exactly and carries
 * no client-side extras.
 */
export type CreateComputerRequest = ComputerSpec;

export interface ComputerListResponse {
  computers: ComputerInfo[];
}

export interface ExecRequestBody {
  cmd: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  stdin?: string;
  tty?: boolean;
  user?: string;
  maxOutputBytes?: number;
}

/**
 * One frame of `POST /v1/computers/:id/exec/stream`.
 *
 * The payload field is `data`, not `text` -- see `routes/computers.ts`. The stream
 * ends with an `event: done` frame, which the SSE reader consumes rather than
 * yielding.
 */
export type ExecEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; result: ExecResult };

export interface ListDirResponse {
  entries: DirEntry[];
}

// -- husks -------------------------------------------------------------------

/** What `GET /v1/husks` lists. Not a `HuskSpec` -- a projection of one. */
export interface HuskSummary {
  name: string;
  displayName: string;
  description: string;
  model: string;
  version: string;
  tools: string[];
  triggers: string[];
  computer: { enabled: boolean; flavor: string };
  updatedAt: string;
  runCount: number;
}

export interface HuskListResponse {
  husks: HuskSummary[];
}

/** `GET /v1/husks/:name`. Both the parsed spec and the YAML it was written from. */
export interface HuskDocument {
  spec: HuskSpec;
  yaml: string;
}

/**
 * Body for create / update / validate.
 *
 * The server reads `spec` or `yaml` off the body -- a bare spec is rejected with
 * "body must carry either `spec` or `yaml`".
 */
export type HuskInput = { spec: unknown; yaml?: never } | { yaml: string; spec?: never };

/** `POST /v1/husks/validate`. Answers 200 either way; `ok` carries the verdict. */
export type ValidateResponse = { ok: true; issues?: undefined } | { ok: false; issues: string[] };

// -- runs --------------------------------------------------------------------

export interface RunRequestBody {
  input?: string | ModelMessage[];
  history?: ModelMessage[];
  model?: string;
  vars?: Record<string, string>;
  maxSteps?: number;
  maxCostUsd?: number;
  approvalMode?: 'auto' | 'ask' | 'readonly';
  computerId?: string;
}

export type RunStatus = 'running' | 'complete' | 'step_limit' | 'budget' | 'timeout' | 'aborted' | 'loop' | 'error';

/** The index record for a run. `status`, not `state`; several fields are optional. */
export interface RunSummary {
  runId: string;
  husk: string;
  model: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  steps?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  preview?: string;
  error?: { message: string; code?: string };
}

export interface RunListResponse {
  runs: RunSummary[];
  nextCursor?: string;
}

/**
 * `GET /v1/runs/:runId`.
 *
 * A run still in flight has no `result.json` yet, so the server substitutes the
 * summary rather than 404-ing a poller. The union is the honest type.
 */
export interface RunDetail {
  result: RunResult | RunSummary;
  events: RunEvent[];
}

/** `POST /v1/runs/:runId/cancel` -> 202. Idempotent: a finished run is not an error. */
export interface CancelResponse {
  runId: string;
  cancelled: boolean;
  status: RunStatus;
}

// -- approvals ---------------------------------------------------------------

export interface PendingApproval {
  approvalId: string;
  runId: string;
  husk: string;
  call: ToolCallPart;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovalListResponse {
  approvals: PendingApproval[];
}

export interface ApprovalAnswerBody {
  approve: boolean;
  remember?: boolean;
}

export interface ApprovalAnswerResponse {
  approvalId: string;
  approved: boolean;
  remembered: boolean;
}

// -- sessions ----------------------------------------------------------------

/** What `GET /v1/sessions/discover` found on disk. The file path is `origin`. */
export interface DiscoveredSession {
  id: string;
  source: TranscriptSource;
  title: string;
  messageCount: number;
  updatedAt: string;
  origin: string;
}

export interface DiscoverResponse {
  sessions: DiscoveredSession[];
}

export interface ImportRequestBody {
  path?: string;
  content?: string;
  source?: TranscriptSource;
}

export interface ImportResponse {
  transcript: Transcript;
}

export interface DistillRequestBody {
  transcriptId?: string;
  transcript?: Transcript;
  /** Spend a model call on the distillation. Off by default: the heuristic is free. */
  useModel?: boolean;
  model?: string;
}

export interface DistillResponse {
  distilled: DistilledAgent;
  spec: HuskSpec;
  yaml: string;
}

/** `POST /v1/sessions/distill/stream`. Progress frames, then exactly one `done`. */
export type DistillEvent =
  | { type: 'progress'; stage: 'scanning' | 'extracting' | 'merging'; pct: number }
  | { type: 'done'; spec: HuskSpec; distilled: DistilledAgent; yaml: string };

// -- models ------------------------------------------------------------------

export interface ModelProviderStatus {
  id: string;
  displayName: string;
  priority: number;
  available: boolean;
  reason?: string;
  hint?: string;
}

export interface ModelListResponse {
  models: ModelInfo[];
  providers: ModelProviderStatus[];
}

/** `POST /v1/models/chat`. Mirrors the server's `ChatRequestSchema`. */
export interface ChatRequestBody {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string | ContentPart[]; name?: string }>;
  system?: string;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  thinking?: { enabled: boolean; budgetTokens?: number };
  responseFormat?: { type: 'text' } | { type: 'json'; schema?: Record<string, unknown> };
  metadata?: Record<string, string>;
}

// -- events (websocket) ------------------------------------------------------

export type EventTopic = 'computers' | 'runs' | 'providers' | 'triggers' | 'adapters' | 'reaper';

/** A live event from `WS /v1/events`. `hello` arrives first, unprompted. */
export interface HuskEventMessage {
  type: string;
  at: string;
  topic: EventTopic;
  payload: unknown;
}

/** The acknowledgement of `{ type: 'subscribe' }`. Carries no `topic`/`payload`. */
export interface HuskSubscribedMessage {
  type: 'subscribed';
  at: string;
  topics: EventTopic[];
}

export interface HuskPongMessage {
  type: 'pong';
  at: string;
}

export type HuskEventFrame = HuskEventMessage | HuskSubscribedMessage | HuskPongMessage;

export type {
  ChatResponse,
  ComputerInfo,
  ComputerSpec,
  ContentPart,
  DirEntry,
  DistilledAgent,
  ExecResult,
  HuskSpec,
  ModelInfo,
  ModelMessage,
  PortBinding,
  RunEvent,
  RunResult,
  StreamEvent,
  ToolCallPart,
  Transcript,
  TranscriptSource,
  Usage,
};
