/**
 * The wire shapes this console actually receives.
 *
 * The rule is: import the type from `@husk-ai/sdk` wherever the SDK and the
 * running server agree, and restate it here only where they still do not —
 * with a comment saying what the SDK claims instead. Each restatement carries
 * its own reason; this file is the list, and there is no second copy of it.
 * It previously pointed at `apps/console/README.md`, which is still the Vite
 * scaffold template and has never held one.
 *
 * Checked against `packages/server/src/routes/*.ts` and `packages/sdk/src` on
 * 0.1.3. The note saying 0.1.0 had outlived two of the entries below it: the
 * SDK has typed `GET /v1/computers` as an object since then, and it now has a
 * `browse()` method, so both of those restatements are gone.
 *
 * `GET /v1/doctor` used to be the largest of those. It is not any more: the
 * server, `docs/API.md` and the SDK now describe one shape, so the doctor types
 * below are the SDK's, not ours.
 *
 * One import below comes from `@husk-ai/core` instead. `POST /browse` returns a
 * `BrowsePage`, and the SDK neither calls that route nor re-exports its types,
 * so borrowing the SDK's copy is not an option and restating the shape would be
 * worse than depending on the package the server itself returns.
 */

import type { SnapshotNode } from '@husk-ai/browser';
import type { BrowseBody } from '@husk-ai/core/contracts';
import type {
  ComputerInfo,
  ComputerListResponse,
  ComputerSpec,
  DirEntry,
  DoctorModelProvider,
  DoctorProvider as SdkDoctorProvider,
  DoctorReport as SdkDoctorReport,
  ExecResult,
  HealthReport as SdkHealthReport,
  HuskSpec,
  ModelInfo,
  RunEvent,
} from '@husk-ai/sdk';

export type {
  ComputerInfo,
  ComputerListResponse,
  ComputerSpec,
  DirEntry,
  DoctorModelProvider,
  ExecResult,
  HuskSpec,
  ModelInfo,
  RunEvent,
};

/**
 * `GET /health`.
 *
 * The shape is the SDK's; only the path diverges — this server routes `/health`
 * and not the `/v1/health` the SDK's `client.health()` asks for, and it is the
 * one endpoint that never needs the token. See `client.ts`.
 */
export type HealthReport = SdkHealthReport & {
  mode?: 'starter' | 'server';
  profile?: 'starter' | 'computer';
};

/**
 * What the isolation boundary actually is, per provider.
 *
 * `kernel` (docker, podman, fly) is a sandbox. `machine` (ssh) is a different
 * box — isolated from *this* laptop, but the agent holds a real shell on the
 * far end. `guardrails` (local) is not isolation at all.
 */
export type IsolationKind = 'kernel' | 'machine' | 'guardrails';

/**
 * `GET /v1/doctor` providers.
 *
 * The SDK's `DoctorProvider` is otherwise correct, but it is missing
 * `isolationKind`: in `packages/sdk/src/types.ts` that field was landed inside
 * `DoctorReport['selection']` instead of on the provider. The server puts it on
 * each provider (`routes/doctor.ts`, from `ProviderStatus.isolationKind` in
 * `@husk-ai/core`) and never sends it on `selection`, and `husk doctor` reads it
 * per provider. So: extend the SDK type by exactly one optional field rather
 * than fork it, and drop this the moment the SDK moves the field.
 */
export interface DoctorProvider extends SdkDoctorProvider {
  isolationKind?: IsolationKind;
}

/** `GET /v1/doctor`. The SDK's report, with the provider fix above applied. */
export type DoctorReport = Omit<SdkDoctorReport, 'providers'> & { providers: DoctorProvider[] };


/** `GET /v1/computers/:id/fs?path=` */
export interface DirListResponse {
  entries: DirEntry[];
}

/**
 * `POST /v1/computers/:id/browse` -> `BrowsePage`.
 *
 * These come straight from `@husk-ai/core`, not from `@husk-ai/sdk`. The SDK
 * calls this route now — `HuskClient.computers.browse()` — but its `types.ts`
 * re-export list still does not carry the browse types, so core remains the
 * only place to get them. Nothing here is restated.
 *
 * The request body is `BrowseBody`, which core already splits out of
 * `BrowseRequest` for exactly this reason: `signal` is an in-process handle
 * rather than a wire field, and the route's zod schema is `.strict()`, so
 * sending it would 422. The console used to rebuild that type by hand.
 */
export type { BrowseLink, BrowsePage } from '@husk-ai/core/contracts';
export type BrowseRequestBody = BrowseBody;

/**
 * `POST /v1/computers/:id/browser/*` — the real Chromium.
 *
 * `SnapshotNode` is `@husk-ai/browser`'s, for the same reason `BrowsePage` is
 * `@husk-ai/core`'s: the SDK models none of these routes, so the package the
 * server returns the shape from is the only honest place to get it. The
 * dependency is type-only and erases at build.
 *
 * The three envelopes below are restated because the handlers in
 * `packages/server/src/routes/browser.ts` build their bodies inline and export
 * no interface to import. Checked against that file on `@husk-ai/server` 0.1.0:
 * `goto` -> `{ url, loaded, title }`; `snapshot`, `click` and `type` all ->
 * `{ url, nodes }`. `goto` returning no nodes is why the panel snapshots after
 * it navigates and not after a click.
 */
export type { SnapshotNode };

export interface BrowserGotoBody {
  url: string;
  timeoutSec?: number;
}

export interface BrowserGotoResult {
  url: string;
  /** False when the load timed out. The page is still usable, just not finished. */
  loaded: boolean;
  title: string;
}

export interface BrowserSnapshotResult {
  url: string;
  nodes: SnapshotNode[];
}

/**
 * `POST /v1/computers/:id/exec/stream`.
 *
 * The payload field is `data`, not the `text` that `@husk-ai/sdk`'s `ExecEvent`
 * declares. The trailing `event: done` frame arrives as a bare `{}`, which the
 * SDK's `decodeEvents` yields rather than swallowing, so `type` is optional.
 */
export type ExecStreamEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; result: ExecResult }
  | { type?: undefined };

/** `GET /v1/husks` rows, and the body returned by POST/PUT `/v1/husks`. */
export interface HuskSummary {
  name: string;
  displayName: string;
  description: string;
  model: string;
  /** `builtin`, or the person's own `claude-code` or `codex`. Absent from an older Husk. */
  engine?: string;
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

/** `GET /v1/husks/:name` */
export interface HuskDetail {
  spec: HuskSpec;
  yaml: string;
}

/** `POST /v1/husks/validate` — always 200; failure is in the body. */
export type ValidateResult = { ok: true; issues?: undefined } | { ok: false; issues: string[] };

export interface RunRequestBody {
  input: string;
  model?: string;
  maxSteps?: number;
  maxCostUsd?: number;
  timeoutSec?: number;
  approvalMode?: 'auto' | 'ask' | 'readonly';
  vars?: Record<string, string>;
  computerId?: string;
}

/** A `RunEvent`, or the empty object the terminating `event: done` frame carries. */
export type RunStreamEvent = RunEvent | { type?: undefined };

/** `GET /v1/handoffs` row. `reason` is model text: render it as text, never as HTML. */
export interface PendingHandoff {
  handoffId: string;
  runId: string;
  husk: string;
  reason: string;
  computerId?: string;
  createdAt: string;
}

export interface HandoffFrame {
  image: Blob;
  /** The page's CSS viewport, for mapping a click on the image back to the page. */
  width: number;
  height: number;
}

export type HandoffKey =
  | 'Enter'
  | 'Tab'
  | 'Escape'
  | 'Backspace'
  | 'Delete'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown';

export type HandoffInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right'; double?: boolean }
  | { type: 'scroll'; x: number; y: number; dx?: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: HandoffKey };

export interface ApprovalAnswer {
  approvalId: string;
  approved: boolean;
  remembered: boolean;
}

export interface ModelListResponse {
  models: ModelInfo[];
  providers: ModelProviderStatus[];
}

export interface ModelProviderStatus {
  id: string;
  displayName: string;
  priority: number;
  available: boolean;
  reason?: string;
  hint?: string;
}

/** `WS /v1/events` */
export const EVENT_TOPICS = ['computers', 'runs', 'providers', 'triggers', 'adapters', 'reaper'] as const;
export type EventTopic = (typeof EVENT_TOPICS)[number];

export interface HuskWireEvent {
  type: string;
  at: string;
  topic?: EventTopic | string;
  payload?: unknown;
}

/**
 * `WS /v1/computers/:id/terminal`.
 *
 * `docs/API.md` describes this socket as carrying "raw bytes as stdin/stdout".
 * The implementation carries JSON frames in both directions and runs one
 * command per inbound message — there is no pty behind it. See the console
 * README.
 */
export type TerminalFrame =
  | { type: 'ready'; computerId: string; workdir: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; exitCode: number; durationMs: number }
  | { type: 'error'; error: string };

/** The one control frame `docs/API.md` documents for the terminal socket. */
export interface TerminalResizeFrame {
  type: 'resize';
  cols: number;
  rows: number;
}

export function isTerminalFrame(value: unknown): value is TerminalFrame {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'ready' || t === 'stdout' || t === 'stderr' || t === 'exit' || t === 'error';
}

export function isWireEvent(value: unknown): value is HuskWireEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; at?: unknown };
  return typeof v.type === 'string' && typeof v.at === 'string';
}

/**
 * `GET /v1/computers/:id/browser/status`.
 *
 * Restated rather than imported: the route builds this body inline and exports
 * no interface for it.
 */
export interface BrowserStatus {
  installed: boolean;
  source?: 'system' | 'cached' | 'downloaded';
  version?: string;
}

/** `GET /v1/scoped/computer`: the one computer a card's link opens. */
export interface ScopedComputer {
  computerId: string;
  label?: string;
  /** Where it runs; absent from an older Husk. */
  provider?: string;
  state: string;
  handoff: PendingHandoff | null;
}

/** One running run, from `GET /v1/overview`. */
export interface ActiveRunInfo {
  runId: string;
  husk: string;
  startedAt: string;
  computerId?: string;
  step?: number;
  tool?: string;
}

/** `GET /v1/overview`. */
export interface Overview {
  computers: ComputerInfo[];
  activeRuns: ActiveRunInfo[];
  handoffs: PendingHandoff[];
  /** The last tool call on each computer, chats included. Absent from older servers. */
  activity?: Record<string, ActivityEntry>;
  /** The AI's call running on each computer now: what a take-over waits for. Absent from older servers. */
  running?: Record<string, { tool: string; since: string }>;
  /** Computers a chat runs in its own process: watched and taken over from the chat's link. Absent from older servers. */
  inChat?: string[];
}

/** One tool call on a computer. `summary` never carries typed text. */
export interface ActivityEntry {
  at: string;
  tool: string;
  ok: boolean;
  ms: number;
  via: string;
  summary?: string;
}

/** `POST /v1/computers/:id/bot`: a draft husk.yaml from the chat, to review before saving. */
export interface BotDraft {
  transcriptId: string;
  yaml: string;
  spec: { name: string; engine?: { type: BotEngine; resume?: string } };
  distilled: { confidence?: number; notes?: string[] };
  /** What the draft can run on, best first; absent from an older Husk. */
  engines?: BotEngine[];
  /** On Claude Code, the bot would go on with this chat rather than start from the draft. */
  continues?: boolean;
}

/** What a bot made from a chat runs on: the person's own Claude Code or Codex, or Husk's own engine. */
export type BotEngine = 'claude-code' | 'codex' | 'builtin';

/** A chat Husk found on this machine, as `GET /v1/sessions/discover` lists it. */
export interface FoundChat {
  id: string;
  source: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  /** The file it is in. */
  origin: string;
}

/** `POST /v1/sessions/import`: the chat, or, for a file that holds many, which one. */
export type ImportedChat =
  | { transcript: { id: string; title?: string; source: string } }
  | { source: string; choices: Array<{ id: string; title: string; messages: number; updatedAt?: string }> };

/** A chat app Husk can connect, as `GET /v1/setup` reports it. */
export interface ChatApp {
  id: string;
  name: string;
  found: boolean;
  connected: boolean;
  /** Husk is in it, but starts an older or another Husk: Update moves it here. Absent from older servers. */
  outdated?: boolean;
  where: string;
  after: string;
}

/** A computer provider and whether this machine can run it. */
export interface ComputerOption {
  name: string;
  description: string;
  available: boolean;
  isolated?: boolean | null;
  reason?: string;
  hint?: string;
}

export interface SetupState {
  apps: ChatApp[];
  computers: ComputerOption[];
}

export interface ConnectResult {
  id: string;
  ok: boolean;
  message: string;
  backup?: string;
}

export interface ComputerChoice {
  provider?: string;
  flavor?: 'base' | 'python' | 'node' | 'full';
}

/** One message on `WS /v1/computers/:id/screen`. */
/** One open tab, from `GET /v1/computers/:id/browser/tabs`. `active` is the one the screen shows. */
export interface BrowserTab {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
}

export type ScreenMessage =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'idle'; message: string }
  | { type: 'error'; code: string; message: string };

/** `GET /v1/computers/:id/stats`. Null means not measured; `notes` says why. */
export interface ComputerStats {
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  diskBytes: number | null;
  notes?: string[];
}
