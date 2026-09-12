import type {
  BrowseBody,
  BrowsePage,
  ChatResponse,
  ComputerInfo,
  ExecResult,
  PortBinding,
  RunEvent,
  RunResult,
  StreamEvent,
} from '@husk/core';
import { openEventStream } from './events.js';
import type { EventStreamOptions, HuskEventStream } from './events.js';
import { Http } from './http.js';
import type { HuskClientOptions } from './http.js';
import type {
  ApprovalAnswerBody,
  ApprovalAnswerResponse,
  ApprovalListResponse,
  CancelResponse,
  ChatRequestBody,
  ComputerListResponse,
  CreateComputerRequest,
  DiscoverResponse,
  DistillEvent,
  DistillRequestBody,
  DistillResponse,
  DoctorReport,
  ExecEvent,
  ExecRequestBody,
  HealthReport,
  HuskDocument,
  HuskInput,
  HuskListResponse,
  HuskSummary,
  ImportRequestBody,
  ImportResponse,
  ListDirResponse,
  ModelListResponse,
  RunDetail,
  RunListResponse,
  RunRequestBody,
  ValidateResponse,
} from './types.js';

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The typed control-plane client.
 *
 * Every method maps to exactly one route in `packages/server/src/routes/`, and
 * returns that route's response body verbatim -- envelopes included. There is no
 * client-side caching and no retry: a caller that wants either can wrap this, and
 * a client that silently retried a run would bill twice.
 */
export class HuskClient {
  readonly http: Http;
  readonly computers: ComputersApi;
  readonly husks: HusksApi;
  readonly runs: RunsApi;
  readonly approvals: ApprovalsApi;
  readonly sessions: SessionsApi;
  readonly models: ModelsApi;

  constructor(opts: HuskClientOptions = {}) {
    this.http = new Http(opts);
    this.computers = new ComputersApi(this.http);
    this.husks = new HusksApi(this.http);
    this.runs = new RunsApi(this.http);
    this.approvals = new ApprovalsApi(this.http);
    this.sessions = new SessionsApi(this.http);
    this.models = new ModelsApi(this.http);
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /**
   * Cheap liveness check.
   *
   * `GET /health` -- outside `/v1`, and the one route that answers without a
   * token even when the server has one configured.
   */
  health(opts: CallOptions = {}): Promise<HealthReport> {
    return this.http.request<HealthReport>('GET', '/health', opts);
  }

  /** The honest state of the machine: providers, models, what would be selected. */
  doctor(opts: CallOptions = {}): Promise<DoctorReport> {
    return this.http.request<DoctorReport>('GET', '/v1/doctor', opts);
  }

  /** The `WS /v1/events` firehose: computer state, run lifecycle, provider flips. */
  events(opts: EventStreamOptions = {}): HuskEventStream {
    return openEventStream(this.http, opts);
  }
}

class ComputersApi {
  constructor(private readonly http: Http) {}

  list(opts: CallOptions = {}): Promise<ComputerListResponse> {
    return this.http.request<ComputerListResponse>('GET', '/v1/computers', opts);
  }

  create(spec: CreateComputerRequest = {}, opts: CallOptions = {}): Promise<ComputerInfo> {
    return this.http.request<ComputerInfo>('POST', '/v1/computers', { ...opts, body: spec });
  }

  get(id: string, opts: CallOptions = {}): Promise<ComputerInfo> {
    return this.http.request<ComputerInfo>('GET', `/v1/computers/${enc(id)}`, opts);
  }

  destroy(id: string, opts: CallOptions = {}): Promise<void> {
    return this.http.request<void>('DELETE', `/v1/computers/${enc(id)}`, opts);
  }

  stop(id: string, opts: CallOptions = {}): Promise<ComputerInfo> {
    return this.http.request<ComputerInfo>('POST', `/v1/computers/${enc(id)}/stop`, opts);
  }

  start(id: string, opts: CallOptions = {}): Promise<ComputerInfo> {
    return this.http.request<ComputerInfo>('POST', `/v1/computers/${enc(id)}/start`, opts);
  }

  /** Run a command and wait for it. Use `execStream` when the output matters live. */
  exec(id: string, req: ExecRequestBody, opts: CallOptions = {}): Promise<ExecResult> {
    // A slow command must not trip the client timeout before the server's own
    // exec timeout does, because the server's error is the useful one.
    const timeoutMs = opts.timeoutMs ?? (req.timeoutSec ? (req.timeoutSec + 15) * 1000 : undefined);
    return this.http.request<ExecResult>('POST', `/v1/computers/${enc(id)}/exec`, {
      ...opts,
      ...(timeoutMs ? { timeoutMs } : {}),
      body: req,
    });
  }

  execStream(id: string, req: ExecRequestBody, opts: CallOptions = {}): AsyncIterable<ExecEvent> {
    return this.http.stream<ExecEvent>('POST', `/v1/computers/${enc(id)}/exec/stream`, { ...opts, body: req });
  }

  listDir(id: string, path: string, opts: CallOptions = {}): Promise<ListDirResponse> {
    return this.http.request<ListDirResponse>('GET', `/v1/computers/${enc(id)}/fs`, { ...opts, query: { path } });
  }

  /**
   * The file's bytes.
   *
   * The route answers `application/octet-stream`, not JSON -- there is no
   * base64-in-JSON variant on this server, so there is none here either.
   */
  readFile(id: string, path: string, opts: CallOptions = {}): Promise<Uint8Array> {
    return this.http.bytes('GET', `/v1/computers/${enc(id)}/fs/read`, { ...opts, query: { path } });
  }

  /** `readFile`, decoded as UTF-8. Same single round trip. */
  async readTextFile(id: string, path: string, opts: CallOptions = {}): Promise<string> {
    return new TextDecoder().decode(await this.readFile(id, path, opts));
  }

  /** Raw bytes in, 204 out. Text is sent as UTF-8. */
  writeFile(id: string, path: string, content: string | Uint8Array, opts: CallOptions = {}): Promise<void> {
    return this.http.request<void>('PUT', `/v1/computers/${enc(id)}/fs/write`, {
      ...opts,
      query: { path },
      raw: content,
      ...(typeof content === 'string' ? { contentType: 'text/plain; charset=utf-8' } : {}),
    });
  }

  /**
   * A whole directory, as a gzipped tar.
   *
   * The archive is built by the computer's own `tar`, so this works on every
   * provider including the ones whose filesystem the host cannot see. Paths
   * inside it are relative to `path`, so it can be unpacked anywhere.
   *
   * The default timeout is generous: tarring a source tree on a cold machine
   * takes longer than the client's usual 15s, and aborting mid-archive leaves
   * work the machine was still doing.
   */
  download(id: string, path: string, opts: CallOptions = {}): Promise<Uint8Array> {
    return this.http.bytes('GET', `/v1/computers/${enc(id)}/fs/download`, {
      timeoutMs: 300_000,
      ...opts,
      query: { path },
    });
  }

  /**
   * Unpack a gzipped tar into the computer, creating `path` if it is missing.
   *
   * The body is the archive itself rather than a multipart form: there is one
   * part, and a parser to unwrap it would exist for no other reason.
   */
  upload(
    id: string,
    path: string,
    archive: Uint8Array,
    opts: CallOptions = {},
  ): Promise<{ path: string; bytes: number; entries: number }> {
    return this.http.request<{ path: string; bytes: number; entries: number }>(
      'POST',
      `/v1/computers/${enc(id)}/fs/upload`,
      { timeoutMs: 300_000, ...opts, query: { path }, raw: archive, contentType: 'application/gzip' },
    );
  }

  remove(id: string, path: string, opts: CallOptions & { recursive?: boolean } = {}): Promise<void> {
    const { recursive, ...rest } = opts;
    return this.http.request<void>('DELETE', `/v1/computers/${enc(id)}/fs`, {
      ...rest,
      query: { path, ...(recursive ? { recursive: true } : {}) },
    });
  }

  exposePort(id: string, port: number, opts: CallOptions = {}): Promise<PortBinding> {
    return this.http.request<PortBinding>('POST', `/v1/computers/${enc(id)}/ports`, { ...opts, body: { port } });
  }

  /**
   * Load a page from inside the computer.
   *
   * The default timeout is generous on purpose: `browseInComputer` probes for
   * python3 before it fetches, so a cold machine can spend 20s before the
   * request even starts, and the client's usual 15s would abort work the
   * machine was still doing.
   */
  browse(id: string, req: BrowseBody, opts: CallOptions = {}): Promise<BrowsePage> {
    return this.http.request<BrowsePage>('POST', `/v1/computers/${enc(id)}/browse`, {
      timeoutMs: (req.timeoutSec ?? 30) * 1000 + 30_000,
      ...opts,
      body: req,
    });
  }
}

class HusksApi {
  constructor(private readonly http: Http) {}

  list(opts: CallOptions = {}): Promise<HuskListResponse> {
    return this.http.request<HuskListResponse>('GET', '/v1/husks', opts);
  }

  /** The stored spec *and* the YAML it came from. Editing round-trips through both. */
  get(name: string, opts: CallOptions = {}): Promise<HuskDocument> {
    return this.http.request<HuskDocument>('GET', `/v1/husks/${enc(name)}`, opts);
  }

  create(input: HuskInput, opts: CallOptions = {}): Promise<HuskSummary> {
    return this.http.request<HuskSummary>('POST', '/v1/husks', { ...opts, body: input });
  }

  update(name: string, input: HuskInput, opts: CallOptions = {}): Promise<HuskSummary> {
    return this.http.request<HuskSummary>('PUT', `/v1/husks/${enc(name)}`, { ...opts, body: input });
  }

  delete(name: string, opts: CallOptions = {}): Promise<void> {
    return this.http.request<void>('DELETE', `/v1/husks/${enc(name)}`, opts);
  }

  /**
   * Validate without storing.
   *
   * This is the one endpoint that reports failure with a 200: the question is
   * "is this spec valid", and "no, here is why" is a successful answer to it.
   * Check `ok`; do not rely on a throw.
   */
  validate(input: HuskInput, opts: CallOptions = {}): Promise<ValidateResponse> {
    return this.http.request<ValidateResponse>('POST', '/v1/husks/validate', { ...opts, body: input });
  }

  /** Run to completion. Prefer `runStream` for anything a human is watching. */
  run(name: string, body: RunRequestBody, opts: CallOptions = {}): Promise<RunResult> {
    return this.http.request<RunResult>('POST', `/v1/husks/${enc(name)}/run`, {
      ...opts,
      body,
      timeoutMs: opts.timeoutMs ?? 0,
    });
  }

  runStream(name: string, body: RunRequestBody, opts: CallOptions = {}): AsyncIterable<RunEvent> {
    return this.http.stream<RunEvent>('POST', `/v1/husks/${enc(name)}/run/stream`, { ...opts, body });
  }
}

class RunsApi {
  constructor(private readonly http: Http) {}

  list(opts: CallOptions & { husk?: string; limit?: number; cursor?: string } = {}): Promise<RunListResponse> {
    const { husk, limit, cursor, ...rest } = opts;
    return this.http.request<RunListResponse>('GET', '/v1/runs', {
      ...rest,
      query: { ...(husk ? { husk } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
    });
  }

  /** The result and the full event log. In-flight runs return the summary instead. */
  get(runId: string, opts: CallOptions = {}): Promise<RunDetail> {
    return this.http.request<RunDetail>('GET', `/v1/runs/${enc(runId)}`, opts);
  }

  /**
   * Ask a running agent to stop. 202, idempotent.
   *
   * `cancelled: false` means it had already finished -- not a failure, and worth
   * not making the caller distinguish.
   */
  cancel(runId: string, opts: CallOptions = {}): Promise<CancelResponse> {
    return this.http.request<CancelResponse>('POST', `/v1/runs/${enc(runId)}/cancel`, opts);
  }

  /** Cancel if running, then delete the stored transcript and events. */
  delete(runId: string, opts: CallOptions = {}): Promise<void> {
    return this.http.request<void>('DELETE', `/v1/runs/${enc(runId)}`, opts);
  }
}

class ApprovalsApi {
  constructor(private readonly http: Http) {}

  /** Approvals waiting on an answer. They expire 120 s after they are raised. */
  list(opts: CallOptions = {}): Promise<ApprovalListResponse> {
    return this.http.request<ApprovalListResponse>('GET', '/v1/approvals', opts);
  }

  answer(approvalId: string, body: ApprovalAnswerBody, opts: CallOptions = {}): Promise<ApprovalAnswerResponse> {
    return this.http.request<ApprovalAnswerResponse>('POST', `/v1/approvals/${enc(approvalId)}`, {
      ...opts,
      body,
    });
  }
}

class SessionsApi {
  constructor(private readonly http: Http) {}

  /** Transcripts found on disk: Claude Code, Cursor, Gemini. `origin` is the path. */
  discover(opts: CallOptions & { source?: string; path?: string } = {}): Promise<DiscoverResponse> {
    const { source, path, ...rest } = opts;
    return this.http.request<DiscoverResponse>('GET', '/v1/sessions/discover', {
      ...rest,
      query: { ...(source ? { source } : {}), ...(path ? { path } : {}) },
    });
  }

  import(body: ImportRequestBody, opts: CallOptions = {}): Promise<ImportResponse> {
    return this.http.request<ImportResponse>('POST', '/v1/sessions/import', { ...opts, body });
  }

  /** chat -> husk.yaml. Returns the distilled agent, the parsed spec, and the YAML. */
  distill(body: DistillRequestBody, opts: CallOptions = {}): Promise<DistillResponse> {
    return this.http.request<DistillResponse>('POST', '/v1/sessions/distill', {
      ...opts,
      body,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  /** The same work with progress frames, for a UI that would otherwise just spin. */
  distillStream(body: DistillRequestBody, opts: CallOptions = {}): AsyncIterable<DistillEvent> {
    return this.http.stream<DistillEvent>('POST', '/v1/sessions/distill/stream', { ...opts, body });
  }
}

class ModelsApi {
  constructor(private readonly http: Http) {}

  /** Every reachable model, plus why each provider is or is not usable. */
  list(opts: CallOptions = {}): Promise<ModelListResponse> {
    return this.http.request<ModelListResponse>('GET', '/v1/models', opts);
  }

  chat(body: ChatRequestBody, opts: CallOptions = {}): Promise<ChatResponse> {
    return this.http.request<ChatResponse>('POST', '/v1/models/chat', {
      ...opts,
      body,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  chatStream(body: ChatRequestBody, opts: CallOptions = {}): AsyncIterable<StreamEvent> {
    return this.http.stream<StreamEvent>('POST', '/v1/models/chat/stream', { ...opts, body });
  }
}

/** Names can contain a slash in theory; encode so they cannot forge a path segment. */
function enc(s: string): string {
  return encodeURIComponent(s);
}
