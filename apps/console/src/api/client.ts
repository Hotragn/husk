/**
 * The console's control-plane client.
 *
 * Built on `@husk-ai/sdk`: `HuskClient` owns the transport, the URL building, the
 * timeout composition and — the part that matters most here — turning a failed
 * response back into the same `HuskError` (code + message + hint) the server
 * threw. Every error surface in this UI renders those three fields directly.
 *
 * Where `HuskClient`'s typed façade still points at a path or a shape the
 * server does not serve, this file calls through `client.http` (a documented,
 * public part of the SDK) with the verified path and a verified type from
 * `wire.ts`. Each of those is commented with what the SDK says instead, and the
 * full list is in `apps/console/README.md`. Nothing here is `any`.
 */

import { HuskClient, HuskError, errorFromResponse, isHuskError, transportError } from '@husk-ai/sdk';
import type {
  ApprovalAnswer,
  BrowseRequestBody,
  BrowsePage,
  BrowserGotoBody,
  BrowserGotoResult,
  BrowserSnapshotResult,
  ComputerInfo,
  ComputerListResponse,
  ComputerSpec,
  DirEntry,
  DirListResponse,
  DoctorReport,
  ExecStreamEvent,
  HealthReport,
  HuskDetail,
  HuskListResponse,
  HuskSummary,
  ModelListResponse,
  RunRequestBody,
  RunStreamEvent,
  BrowserStatus,
  ValidateResult,
} from './wire';

export { HuskError, isHuskError };

/**
 * How long a `/browser/*` call is allowed to take.
 *
 * Not a guess: the first call launches Chromium, and `provisionChromium` may
 * download ~111 MB and unpack it inside the computer before anything answers.
 * Measured on a warm session the same calls return in tens of milliseconds, so
 * this budget only ever gets spent once per machine.
 */
const PROVISION_BUDGET_MS = 600_000;

export interface HuskApiOptions {
  baseUrl: string;
  token?: string;
}

/** A shell command to run in a computer. Mirrors the server's `ExecSchema`. */
export interface ExecRequest {
  cmd: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  stdin?: string;
  tty?: boolean;
  maxOutputBytes?: number;
}

export class HuskApi {
  readonly baseUrl: string;
  private readonly client: HuskClient;
  private readonly token: string | undefined;

  constructor(opts: HuskApiOptions) {
    this.baseUrl = stripTrailingSlash(opts.baseUrl);
    this.token = opts.token && opts.token.length > 0 ? opts.token : undefined;
    this.client = new HuskClient({
      baseUrl: this.baseUrl,
      ...(this.token ? { token: this.token } : {}),
      timeoutMs: 15_000,
      // `Http` stores `globalThis.fetch` and calls it as `this.fetchImpl(...)`,
      // which detaches it from `window`. In Node that is fine; in a browser it
      // is `TypeError: Illegal invocation` on the first request. Handing it a
      // closure keeps the receiver intact.
      fetch: (input, init) => globalThis.fetch(input, init),
    });
  }

  /** The websocket origin for this base URL. `http:` -> `ws:`, `https:` -> `wss:`. */
  socketUrl(path: string, query?: Record<string, string | number>): string {
    const url = new URL(this.baseUrl + path);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    return url.toString();
  }

  // -- health and doctor ----------------------------------------------------

  /**
   * `GET /health`.
   *
   * Not `client.health()`: the SDK asks for `/v1/health`, which this server does
   * not route. `/health` is also the only endpoint that never needs the token,
   * which makes it the right liveness probe.
   */
  health(signal?: AbortSignal): Promise<HealthReport> {
    return this.client.http.request<HealthReport>('GET', '/health', {
      ...(signal ? { signal } : {}),
      timeoutMs: 4000,
    });
  }

  /** `GET /v1/doctor`. Correct path in the SDK; the SDK's return type is stale. */
  doctor(signal?: AbortSignal): Promise<DoctorReport> {
    return this.client.http.request<DoctorReport>('GET', '/v1/doctor', {
      ...(signal ? { signal } : {}),
      timeoutMs: 20_000,
    });
  }

  // -- computers ------------------------------------------------------------

  /** `GET /v1/computers` -> `{ computers }`. The SDK types a bare array. */
  async listComputers(signal?: AbortSignal): Promise<ComputerInfo[]> {
    const res = await this.client.http.request<ComputerListResponse>('GET', '/v1/computers', {
      ...(signal ? { signal } : {}),
    });
    return res.computers;
  }

  /** `POST /v1/computers`. The SDK method is correct, so use it. */
  createComputer(spec: ComputerSpec): Promise<ComputerInfo> {
    return this.client.computers.create(spec, { timeoutMs: 120_000 });
  }

  stopComputer(id: string): Promise<ComputerInfo> {
    return this.client.computers.stop(id, { timeoutMs: 60_000 });
  }

  startComputer(id: string): Promise<ComputerInfo> {
    return this.client.computers.start(id, { timeoutMs: 120_000 });
  }

  destroyComputer(id: string): Promise<void> {
    return this.client.computers.destroy(id, { timeoutMs: 60_000 });
  }

  // -- exec -----------------------------------------------------------------

  /**
   * `POST /v1/computers/:id/exec/stream`.
   *
   * Not `client.computers.execStream()`: that types the payload field as `text`
   * and the server sends `data`, so every chunk would render as `undefined`.
   */
  execStream(id: string, req: ExecRequest, signal?: AbortSignal): AsyncIterable<ExecStreamEvent> {
    return this.client.http.stream<ExecStreamEvent>('POST', `/v1/computers/${enc(id)}/exec/stream`, {
      body: req,
      ...(signal ? { signal } : {}),
    });
  }

  // -- files ----------------------------------------------------------------

  /** `GET /v1/computers/:id/fs?path=`. The SDK asks for `/dir`, which 404s. */
  async listDir(id: string, path: string, signal?: AbortSignal): Promise<DirEntry[]> {
    const res = await this.client.http.request<DirListResponse>('GET', `/v1/computers/${enc(id)}/fs`, {
      query: { path },
      ...(signal ? { signal } : {}),
    });
    return res.entries;
  }

  /**
   * `GET /v1/computers/:id/fs/read?path=` -> the raw bytes.
   *
   * Real bytes, not a JSON envelope: the SDK's `readFile()` expects a
   * `{ content, encoding }` object from `/files`, an endpoint this server does
   * not have.
   */
  readFileBytes(id: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.client.http.bytes('GET', `/v1/computers/${enc(id)}/fs/read`, {
      query: { path },
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
    });
  }

  /**
   * `PUT /v1/computers/:id/fs/write?path=` with the bytes as the body.
   *
   * `Http.request` JSON-encodes whatever it is handed, so this is the one call
   * that goes out through `fetch` directly. The SDK's own `errorFromResponse`
   * and `transportError` still map the failure, so a path-jail rejection
   * arrives here as the same `HuskError` every other call produces.
   */
  async writeFileBytes(id: string, path: string, bytes: Uint8Array): Promise<void> {
    const url = this.client.http.url(`/v1/computers/${enc(id)}/fs/write`, { path });
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let res: Response;
    try {
      // A fresh ArrayBuffer keeps `fetch` off the SharedArrayBuffer overload.
      const body = bytes.slice().buffer as ArrayBuffer;
      res = await fetch(url, { method: 'PUT', headers, body });
    } catch (err) {
      throw transportError(err, url);
    }
    if (!res.ok) throw errorFromResponse(res.status, await safeJson(res), url);
  }

  /** `DELETE /v1/computers/:id/fs?path=`. The SDK asks for `/files`. */
  removeFile(id: string, path: string, recursive: boolean): Promise<void> {
    return this.client.http.request<void>('DELETE', `/v1/computers/${enc(id)}/fs`, {
      query: { path, ...(recursive ? { recursive: 'true' } : {}) },
      timeoutMs: 30_000,
    });
  }

  // -- browser --------------------------------------------------------------

  /**
   * `POST /v1/computers/:id/browse` -> `BrowsePage`.
   *
   * Not `client.computers.*`: the SDK has no browse method at all, so this goes
   * through `client.http` with the verified path and `@husk-ai/core`'s own return
   * type.
   *
   * The timeout is composed the way the server composes its own. `browseInComputer`
   * spends up to 20s probing for python3, then runs the fetch with
   * `timeoutSec + 10`, so a 15s client timeout — the default here — would abort
   * a request the machine was still honestly working on.
   */
  browse(id: string, req: BrowseRequestBody, signal?: AbortSignal): Promise<BrowsePage> {
    return this.client.http.request<BrowsePage>('POST', `/v1/computers/${enc(id)}/browse`, {
      body: req,
      ...(signal ? { signal } : {}),
      timeoutMs: (req.timeoutSec ?? 30) * 1000 + 30_000,
    });
  }

  /**
   * `POST /v1/computers/:id/browser/goto` -> `{ url, loaded, title }`.
   *
   * The real Chromium, not the fetch-and-strip fallback above. The timeout is
   * the reason this is not a one-liner: the *first* call into any of these
   * endpoints may launch the browser, and launching it may first download and
   * unpack ~111 MB inside the computer over the computer's own egress path. A
   * 15s client timeout would abort a machine that was working honestly, and the
   * user would see a transport error instead of a download. Ten minutes is the
   * budget for that; the panel counts the seconds out loud while it runs.
   */
  /**
   * Is Chromium already in this computer?
   *
   * Asked before the download pre-flight is shown, so a machine that already
   * has one is not offered 111 MB it does not need. Cheap and side-effect free
   * -- the server looks, it does not install -- so the ordinary short timeout
   * applies rather than the provisioning budget.
   */
  browserStatus(id: string, signal?: AbortSignal): Promise<BrowserStatus> {
    return this.client.http.request<BrowserStatus>('GET', `/v1/computers/${enc(id)}/browser/status`, {
      ...(signal ? { signal } : {}),
    });
  }

  browserGoto(id: string, body: BrowserGotoBody, signal?: AbortSignal): Promise<BrowserGotoResult> {
    return this.client.http.request<BrowserGotoResult>('POST', `/v1/computers/${enc(id)}/browser/goto`, {
      body,
      ...(signal ? { signal } : {}),
      timeoutMs: PROVISION_BUDGET_MS,
    });
  }

  /**
   * `POST /v1/computers/:id/browser/snapshot` -> `{ url, nodes }`.
   *
   * The accessibility tree, flattened. This is the interaction model: each node
   * carries a `ref` that `click` and `type` resolve back to the exact DOM node
   * that produced it. Coordinates are deliberately not on this surface.
   */
  browserSnapshot(id: string, limit?: number, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    return this.client.http.request<BrowserSnapshotResult>('POST', `/v1/computers/${enc(id)}/browser/snapshot`, {
      body: limit === undefined ? {} : { limit },
      ...(signal ? { signal } : {}),
      timeoutMs: PROVISION_BUDGET_MS,
    });
  }

  /** `POST /v1/computers/:id/browser/click` -> the snapshot *after* the click. */
  browserClick(id: string, ref: string, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    return this.client.http.request<BrowserSnapshotResult>('POST', `/v1/computers/${enc(id)}/browser/click`, {
      body: { ref },
      ...(signal ? { signal } : {}),
      timeoutMs: PROVISION_BUDGET_MS,
    });
  }

  /** `POST /v1/computers/:id/browser/type` -> the snapshot after the keystrokes. */
  browserType(
    id: string,
    ref: string,
    text: string,
    submit?: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserSnapshotResult> {
    return this.client.http.request<BrowserSnapshotResult>('POST', `/v1/computers/${enc(id)}/browser/type`, {
      body: { ref, text, ...(submit ? { submit: true } : {}) },
      ...(signal ? { signal } : {}),
      timeoutMs: PROVISION_BUDGET_MS,
    });
  }

  /**
   * `GET /v1/computers/:id/browser/screenshot` -> PNG bytes.
   *
   * Bytes rather than a URL handed to `<img src>`: the console authenticates
   * with a bearer token and an `<img>` cannot carry a header, so pointing one
   * at the path would 401 on every token-protected server. The caller turns
   * these into an object URL, which also makes each still a distinct resource —
   * no cache-busting query string, and no chance of the browser re-showing the
   * previous frame.
   */
  browserScreenshot(id: string, fullPage = false, signal?: AbortSignal): Promise<Uint8Array> {
    return this.client.http.bytes('GET', `/v1/computers/${enc(id)}/browser/screenshot`, {
      ...(fullPage ? { query: { fullPage: '1' } } : {}),
      ...(signal ? { signal } : {}),
      timeoutMs: 60_000,
    });
  }

  /** `DELETE /v1/computers/:id/browser`. Closes Chromium; the profile survives. */
  browserClose(id: string): Promise<void> {
    return this.client.http.request<void>('DELETE', `/v1/computers/${enc(id)}/browser`, { timeoutMs: 30_000 });
  }

  // -- husks ----------------------------------------------------------------

  /** `GET /v1/husks` -> `{ husks: HuskSummary[] }`. The SDK types `HuskSpec[]`. */
  async listHusks(signal?: AbortSignal): Promise<HuskSummary[]> {
    const res = await this.client.http.request<HuskListResponse>('GET', '/v1/husks', {
      ...(signal ? { signal } : {}),
    });
    return res.husks;
  }

  /** `GET /v1/husks/:name` -> `{ spec, yaml }`. The SDK types a bare `HuskSpec`. */
  getHusk(name: string, signal?: AbortSignal): Promise<HuskDetail> {
    return this.client.http.request<HuskDetail>('GET', `/v1/husks/${enc(name)}`, {
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * `POST /v1/husks/validate` -> `{ ok, issues? }`, always with status 200.
   *
   * The SDK types this as `{ valid: true, spec }`, which never arrives.
   */
  validateHusk(yaml: string): Promise<ValidateResult> {
    return this.client.http.request<ValidateResult>('POST', '/v1/husks/validate', { body: { yaml } });
  }

  /** `PUT /v1/husks/:name` -> `HuskSummary`. */
  saveHusk(name: string, yaml: string): Promise<HuskSummary> {
    return this.client.http.request<HuskSummary>('PUT', `/v1/husks/${enc(name)}`, { body: { yaml } });
  }

  /**
   * `POST /v1/husks/:name/run/stream`.
   *
   * Singular `run`. The SDK asks for `/runs/stream`, which 404s.
   */
  runStream(name: string, body: RunRequestBody, signal?: AbortSignal): AsyncIterable<RunStreamEvent> {
    return this.client.http.stream<RunStreamEvent>('POST', `/v1/husks/${enc(name)}/run/stream`, {
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /** `POST /v1/approvals/:approvalId`. */
  answerApproval(approvalId: string, approve: boolean, remember = false): Promise<ApprovalAnswer> {
    return this.client.http.request<ApprovalAnswer>('POST', `/v1/approvals/${enc(approvalId)}`, {
      body: { approve, remember },
    });
  }

  // -- models ---------------------------------------------------------------

  /** `GET /v1/models` -> `{ models, providers }`. The SDK types a bare array. */
  listModels(signal?: AbortSignal): Promise<ModelListResponse> {
    return this.client.http.request<ModelListResponse>('GET', '/v1/models', {
      ...(signal ? { signal } : {}),
    });
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Everything the UI needs to render a failure honestly: the code, the sentence,
 * and the next action. Never "Something went wrong" — UI-PRINCIPLES §6.
 */
export interface DisplayError {
  code: string;
  message: string;
  hint?: string;
  details?: string;
}

export function toDisplayError(err: unknown): DisplayError {
  if (isHuskError(err)) {
    const out: DisplayError = { code: err.code, message: err.message };
    if (err.hint) out.hint = err.hint;
    if (err.details && Object.keys(err.details).length > 0) {
      out.details = JSON.stringify(err.details, null, 2);
    }
    return out;
  }
  if (err instanceof Error) {
    return { code: err.name || 'Error', message: err.message, ...(err.stack ? { details: err.stack } : {}) };
  }
  return { code: 'E_UNKNOWN', message: String(err) };
}

/** An abort the user or an unmount caused is not an error worth rendering. */
export function isAbort(err: unknown): boolean {
  if (isHuskError(err)) return err.code === 'E_ABORTED';
  return err instanceof Error && err.name === 'AbortError';
}
