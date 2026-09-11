import { EventEmitter } from 'node:events';
import { createLogger } from '@husk/core';
import type { WebSocket } from 'ws';
import type { AdapterContext, InboundHttpHandler, InboundHttpRequest, InboundHttpResponse } from './types.js';

/**
 * A WebSocket stand-in.
 *
 * The reconnect behaviour is the part of an adapter most likely to be wrong and
 * least likely to be exercised, because provoking it against the real service
 * means waiting for Discord to have a bad day. This lets a test close the socket
 * whenever it likes and assert what happened next.
 */
export class FakeSocket extends EventEmitter {
  static readonly instances: FakeSocket[] = [];

  readyState = 1;
  sent: unknown[] = [];
  closedWith: { code?: number; reason?: string } | undefined;
  terminated = false;

  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }

  static reset(): void {
    FakeSocket.instances.length = 0;
  }

  static get latest(): FakeSocket | undefined {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  terminate(): void {
    this.terminated = true;
    this.close(1006, 'terminated');
  }

  /** Deliver a gateway frame to the adapter. */
  receive(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  /** Everything the adapter sent, filtered by opcode. */
  sentOps(op: number): unknown[] {
    return this.sent.filter((m) => (m as { op?: number }).op === op);
  }
}

export interface TestContext extends AdapterContext {
  runs: Array<{ input: string; userId: string; channelId: string }>;
  routes: Map<string, InboundHttpHandler>;
  abort(): void;
  call(path: string, req: Partial<InboundHttpRequest>): Promise<InboundHttpResponse>;
}

export function testContext(
  overrides: {
    env?: Record<string, string | undefined>;
    husk?: string;
    reply?: string | ((input: string) => string | Promise<string>);
    withHttp?: boolean;
  } = {},
): TestContext {
  const controller = new AbortController();
  const runs: TestContext['runs'] = [];
  const routes = new Map<string, InboundHttpHandler>();
  const reply = overrides.reply ?? 'agent says hi';

  const ctx: TestContext = {
    husk: overrides.husk ?? 'triage',
    log: createLogger({ level: 'silent' }),
    signal: controller.signal,
    env: overrides.env ?? {},
    runs,
    routes,
    async run(input, opts) {
      runs.push({ input, userId: opts.userId, channelId: opts.channelId });
      return typeof reply === 'function' ? reply(input) : reply;
    },
    abort() {
      controller.abort();
    },
    async call(path, req) {
      const handler = routes.get(path);
      if (!handler) throw new Error(`no route mounted at ${path}`);
      return handler({
        method: req.method ?? 'POST',
        headers: req.headers ?? {},
        rawBody: req.rawBody ?? Buffer.alloc(0),
        query: req.query ?? {},
      });
    },
  };

  if (overrides.withHttp !== false) {
    ctx.mountHttp = (path, handler) => {
      routes.set(path, handler);
      return () => routes.delete(path);
    };
  }

  return ctx;
}

/** A `fetch` double that records calls and replays scripted responses. */
export function fakeFetch(
  script: Record<string, unknown> = {},
): typeof fetch & { calls: Array<{ url: string; body: unknown; method: string }> } {
  const calls: Array<{ url: string; body: unknown; method: string }> = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, body, method: init?.method ?? 'GET' });

    const key = Object.keys(script).find((k) => url.includes(k));
    const payload = key ? script[key] : { ok: true };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

export function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

/** Let queued microtasks and zero-delay timers run. */
export function settle(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
