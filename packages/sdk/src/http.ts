import { HUSK_USER_AGENT, HuskError } from '@husk/core';
import { errorFromResponse, transportError } from './errors.js';
import { decodeEvents } from './sse.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The slice of the WHATWG `WebSocket` interface the events client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: never) => void): void;
  removeEventListener?(type: string, listener: (ev: never) => void): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface HuskClientOptions {
  /** Control-plane origin. Defaults to $HUSK_URL, else http://127.0.0.1:7377. */
  baseUrl?: string;
  /** Bearer token. Defaults to $HUSK_TOKEN. */
  token?: string;
  /** Per-request ceiling in ms. 0 disables. Streaming calls are never timed out. */
  timeoutMs?: number;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
  /** Injected for tests, or to route through a custom agent. Defaults to global fetch. */
  fetch?: FetchLike;
  /**
   * WebSocket implementation for `client.events()`.
   *
   * Defaults to `globalThis.WebSocket`, which exists in browsers, Deno, Bun and
   * Node >= 22.4. On Node 20 there is no global, so pass one -- e.g. `ws` --
   * rather than have this package take a dependency the other 95% of callers do
   * not need.
   */
  webSocket?: WebSocketCtor;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-encoded body. */
  body?: unknown;
  /** Bytes sent verbatim, for the raw-body file routes. Mutually exclusive with `body`. */
  raw?: Uint8Array | string;
  /** Content type for `raw`. Defaults to application/octet-stream. */
  contentType?: string;
  signal?: AbortSignal;
  /** Override the client timeout for one call. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:7377';

/**
 * The transport.
 *
 * Deliberately thin: one place that builds a URL, one place that decides a
 * response failed, one place that turns a body into a HuskError. Everything the
 * typed client does is a call into here.
 */
export class Http {
  readonly baseUrl: string;
  readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly baseHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly webSocketImpl: WebSocketCtor | undefined;

  constructor(opts: HuskClientOptions = {}) {
    const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? env.HUSK_URL ?? DEFAULT_BASE_URL);
    this.token = opts.token ?? env.HUSK_TOKEN;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.baseHeaders = { 'user-agent': HUSK_USER_AGENT, ...opts.headers };
    this.webSocketImpl =
      opts.webSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket ?? undefined;

    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) {
      throw new Error('global fetch is missing -- @husk/sdk needs Node >= 20.10 or a fetch polyfill');
    }
    this.fetchImpl = f;
  }

  url(path: string, query?: RequestOptions['query']): string {
    const u = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * The websocket form of `url()`.
   *
   * A browser `WebSocket` cannot set an `Authorization` header, so the server
   * accepts `?token=` on upgrade requests only. That is the same concession the
   * console makes; see `queryToken` in `packages/server/src/auth.ts`.
   */
  wsUrl(path: string, query?: RequestOptions['query']): string {
    const u = new URL(this.url(path, query));
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.token) u.searchParams.set('token', this.token);
    return u.toString();
  }

  /** The configured WebSocket constructor, or an actionable error. */
  webSocketCtor(): WebSocketCtor {
    if (this.webSocketImpl) return this.webSocketImpl;
    throw new HuskError('E_NOT_IMPLEMENTED', 'this runtime has no global WebSocket', {
      hint: "pass one: new HuskClient({ webSocket: (await import('ws')).WebSocket }), or run Node >= 22.4",
    });
  }

  private headers(extra: Record<string, string> | undefined, contentType: string | undefined): Record<string, string> {
    const h: Record<string, string> = { ...this.baseHeaders, accept: 'application/json', ...extra };
    if (contentType) h['content-type'] = contentType;
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private init(opts: RequestOptions, method: string, accept?: string): RequestInit {
    const body = bodyOf(opts);
    return {
      method,
      headers: this.headers({ ...(accept ? { accept } : {}), ...opts.headers }, body?.contentType),
      ...(body ? { body: body.payload } : {}),
    };
  }

  /**
   * One JSON request.
   *
   * The client timeout is composed with the caller's signal rather than
   * replacing it, so `AbortController` from a CLI Ctrl-C still wins.
   */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.url(path, opts.query);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    const signal = opts.signal ? anySignal([opts.signal, controller.signal]) : controller.signal;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...this.init(opts, method), signal });
    } catch (err) {
      throw transportError(err, url);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) throw errorFromResponse(res.status, await safeBody(res), url);
    if (res.status === 204) return undefined as T;
    return (await safeBody(res)) as T;
  }

  /** A streaming request that yields typed SSE events. Never timed out. */
  async *stream<T>(method: string, path: string, opts: RequestOptions = {}): AsyncGenerator<T> {
    const url = this.url(path, opts.query);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...this.init(opts, method, 'text/event-stream'),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      throw transportError(err, url);
    }

    if (!res.ok) throw errorFromResponse(res.status, await safeBody(res), url);
    if (!res.body) throw errorFromResponse(res.status, { error: { message: 'the response had no body' } }, url);

    yield* decodeEvents<T>(res.body, opts.signal, url);
  }

  /** Raw bytes, for the file-read route. */
  async bytes(method: string, path: string, opts: RequestOptions = {}): Promise<Uint8Array> {
    const url = this.url(path, opts.query);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    const signal = opts.signal ? anySignal([opts.signal, controller.signal]) : controller.signal;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...this.init(opts, method, 'application/octet-stream'), signal });
    } catch (err) {
      throw transportError(err, url);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw errorFromResponse(res.status, await safeBody(res), url);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** `BodyInit` is not a global outside the DOM lib; borrow it off `RequestInit`. */
type RequestBody = NonNullable<RequestInit['body']>;

function bodyOf(opts: RequestOptions): { payload: RequestBody; contentType: string } | undefined {
  if (opts.raw !== undefined) {
    const payload: RequestBody =
      typeof opts.raw === 'string'
        ? opts.raw
        : // A fresh copy of the exact bytes: a Uint8Array is a valid body, but a
          // SharedArrayBuffer-backed one is not, and TS models that as a union.
          (opts.raw.slice() as unknown as RequestBody);
    return { payload, contentType: opts.contentType ?? 'application/octet-stream' };
  }
  if (opts.body !== undefined) {
    return { payload: JSON.stringify(opts.body), contentType: opts.contentType ?? 'application/json' };
  }
  return undefined;
}

async function safeBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** AbortSignal.any, with a fallback for the Node 20.10 floor. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const AS = AbortSignal as typeof AbortSignal & { any?: (s: AbortSignal[]) => AbortSignal };
  if (typeof AS.any === 'function') return AS.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
