import type { Logger } from '@husk/core';

/** One inbound message, normalised across every platform. */
export interface InboundMessage {
  /**
   * Platform-native message id. This is the idempotency key: a gateway that
   * redelivers on reconnect must not run the agent twice.
   */
  id: string;
  text: string;
  userId: string;
  userName?: string;
  channelId: string;
  /** Thread or reply target, when the platform has one. */
  threadId?: string;
  isDirect: boolean;
  /** True when the bot was @-mentioned, or when the platform implies it (a DM). */
  mentioned: boolean;
  raw?: unknown;
}

export interface ReplyHandle {
  /** Chunked by the caller to the platform's limit before it reaches the wire. */
  send(text: string): Promise<void>;
  /** Optional: platforms without a typing API simply do not implement it. */
  typing?(): Promise<void>;
}

export interface AdapterRunOptions {
  userId: string;
  channelId: string;
  threadId?: string;
  signal?: AbortSignal;
  /** Called with incremental text when the host can stream. */
  onDelta?: (text: string) => void;
}

/**
 * What an adapter is handed at start.
 *
 * `run` is the only way an adapter reaches the agent. It deliberately does not
 * expose the store, the manager or the Fastify instance: a chat front end's job is
 * to translate a platform's message shape, not to reach into the control plane.
 */
export interface AdapterContext {
  /** The husk this adapter fronts. */
  husk: string;
  log: Logger;
  /** Aborted when the server shuts down. */
  signal: AbortSignal;
  /** Overrides `process.env`, so a test never needs to mutate the real environment. */
  env: Record<string, string | undefined>;
  run(input: string, opts: AdapterRunOptions): Promise<string>;
  /** Register an inbound HTTP route. Absent when there is no HTTP host. */
  mountHttp?(path: string, handler: InboundHttpHandler): () => void;
}

export interface InboundHttpRequest {
  method: string;
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
  query: Record<string, string | undefined>;
}

export interface InboundHttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type InboundHttpHandler = (req: InboundHttpRequest) => Promise<InboundHttpResponse>;

export interface Adapter {
  readonly id: string;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
}

/** Shared shape for the options every adapter accepts. */
export interface BaseAdapterOptions {
  /** Only answer these channel ids. Empty means every channel the bot can see. */
  channels?: string[];
  /** Ignore messages that do not @-mention the bot. DMs always count as mentions. */
  mentionOnly?: boolean;
  /** Per-user ceiling. Defaults to 5 messages per minute. */
  rateLimit?: { messages: number; perMs: number };
  /** Override the env var the token is read from. */
  tokenEnv?: string;
  /** Supply the token directly, bypassing the environment. */
  token?: string;
}
