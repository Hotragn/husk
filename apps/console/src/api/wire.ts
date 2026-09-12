/**
 * The wire shapes this console actually receives.
 *
 * The rule is: import the type from `@husk/sdk` wherever the SDK and the
 * running server agree, and restate it here only where they still do not —
 * with a comment saying what the SDK claims instead. Every remaining
 * restatement was checked against `packages/server/src/routes/*.ts` on
 * `@husk/server` 0.1.0, and the full list is in `apps/console/README.md`.
 *
 * `GET /v1/doctor` used to be the largest of those. It is not any more: the
 * server, `docs/API.md` and the SDK now describe one shape, so the doctor types
 * below are the SDK's, not ours.
 *
 * One import below comes from `@husk/core` instead. `POST /browse` returns a
 * `BrowsePage`, and the SDK neither calls that route nor re-exports its types,
 * so borrowing the SDK's copy is not an option and restating the shape would be
 * worse than depending on the package the server itself returns.
 */

import type { SnapshotNode } from '@husk/browser';
import type { BrowseRequest } from '@husk/core';
import type {
  ComputerInfo,
  ComputerSpec,
  DirEntry,
  DoctorModelProvider,
  DoctorProvider as SdkDoctorProvider,
  DoctorReport as SdkDoctorReport,
  ExecResult,
  HealthReport,
  HuskSpec,
  ModelInfo,
  RunEvent,
} from '@husk/sdk';

export type {
  ComputerInfo,
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
export type { HealthReport };

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
 * `@husk/core`) and never sends it on `selection`, and `husk doctor` reads it
 * per provider. So: extend the SDK type by exactly one optional field rather
 * than fork it, and drop this the moment the SDK moves the field.
 */
export interface DoctorProvider extends SdkDoctorProvider {
  isolationKind?: IsolationKind;
}

/** `GET /v1/doctor`. The SDK's report, with the provider fix above applied. */
export type DoctorReport = Omit<SdkDoctorReport, 'providers'> & { providers: DoctorProvider[] };

/** `GET /v1/computers` — an object, not the bare array `@husk/sdk` types. */
export interface ComputerListResponse {
  computers: ComputerInfo[];
}

/** `GET /v1/computers/:id/fs?path=` */
export interface DirListResponse {
  entries: DirEntry[];
}

/**
 * `POST /v1/computers/:id/browse` -> `BrowsePage`.
 *
 * These come straight from `@husk/core`, not from `@husk/sdk`: the SDK has no
 * browse surface at all — no client method, and its `types.ts` re-export list
 * does not include the browse types — so this is the one place the console
 * reaches past the SDK to the package the route actually returns. Nothing here
 * is restated.
 *
 * The request body is `BrowseRequest` minus `signal`, which is an in-process
 * handle rather than a wire field. The route's zod schema is `.strict()`, so
 * serialising it would 422.
 */
export type { BrowseLink, BrowsePage } from '@husk/core';
export type BrowseRequestBody = Omit<BrowseRequest, 'signal'>;

/**
 * `POST /v1/computers/:id/browser/*` — the real Chromium.
 *
 * `SnapshotNode` is `@husk/browser`'s, for the same reason `BrowsePage` is
 * `@husk/core`'s: the SDK models none of these routes, so the package the
 * server returns the shape from is the only honest place to get it. The
 * dependency is type-only and erases at build.
 *
 * The three envelopes below are restated because the handlers in
 * `packages/server/src/routes/browser.ts` build their bodies inline and export
 * no interface to import. Checked against that file on `@husk/server` 0.1.0:
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
 * The payload field is `data`, not the `text` that `@husk/sdk`'s `ExecEvent`
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
