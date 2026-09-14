import { WebSocket } from 'ws';
import {
  Backoff,
  IdempotencyCache,
  RateLimiter,
  chunkMessage,
  hmacHex,
  safeCompare,
  sleep,
  stripMention,
} from './shared.js';
import type { Adapter, AdapterContext, BaseAdapterOptions, InboundHttpRequest, InboundHttpResponse } from './types.js';

const API = 'https://slack.com/api';
const MESSAGE_LIMIT = 3000;
const SIGNATURE_VERSION = 'v0';
/** Slack's own guidance. Anything older is a replay, not a slow network. */
const REPLAY_WINDOW_SEC = 60 * 5;

export interface SlackSignatureInput {
  signingSecret: string;
  /** Exact bytes as received. A re-serialised body will never verify. */
  rawBody: string | Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  now?: () => number;
}

export interface SlackSignatureResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify `X-Slack-Signature` over `v0:{timestamp}:{body}`.
 *
 * The timestamp check is the half people skip. Without it a captured request is
 * replayable forever, because the signature over a fixed body never expires.
 */
export function verifySlackSignature(input: SlackSignatureInput): SlackSignatureResult {
  if (!input.signature) return { ok: false, reason: 'missing x-slack-signature' };
  if (!input.timestamp) return { ok: false, reason: 'missing x-slack-request-timestamp' };

  const ts = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp is not a unix time' };
  const nowSec = Math.floor((input.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > REPLAY_WINDOW_SEC) return { ok: false, reason: 'timestamp outside the replay window' };

  const body = typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8');
  const expected = `${SIGNATURE_VERSION}=${hmacHex(input.signingSecret, `${SIGNATURE_VERSION}:${input.timestamp}:${body}`)}`;
  return safeCompare(expected, input.signature) ? { ok: true } : { ok: false, reason: 'signature does not match' };
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
}

export interface SlackAdapterOptions extends BaseAdapterOptions {
  /** App-level token (`xapp-...`) for Socket Mode. */
  appTokenEnv?: string;
  appToken?: string;
  /** Signing secret enables the Events API over HTTP instead of Socket Mode. */
  signingSecretEnv?: string;
  signingSecret?: string;
  /** Path for the Events API route, mounted through `ctx.mountHttp`. */
  eventsPath?: string;
  createSocket?: (url: string) => WebSocket;
  fetchImpl?: typeof fetch;
  random?: () => number;
}

/**
 * Slack, two ways.
 *
 * Socket Mode when an app token is present, because it needs no public URL and is
 * the only thing that works behind a laptop's NAT. The Events API over HTTP when a
 * signing secret is configured, because that is what a deployed install uses. Both
 * feed the same handler.
 */
export class SlackAdapter implements Adapter {
  readonly id = 'slack';

  private ctx: AdapterContext | undefined;
  private socket: WebSocket | undefined;
  private stopped = false;
  private botUserId: string | undefined;
  private botToken = '';
  private unmount: (() => void) | undefined;
  private connectLoop: Promise<void> | undefined;
  private readonly backoff: Backoff;
  private readonly seen = new IdempotencyCache();
  private readonly limiter: RateLimiter;
  private readonly channels: Set<string>;
  private readonly mentionOnly: boolean;

  constructor(private readonly opts: SlackAdapterOptions = {}) {
    this.channels = new Set(opts.channels ?? []);
    this.mentionOnly = opts.mentionOnly ?? true;
    this.limiter = new RateLimiter(opts.rateLimit?.messages ?? 5, opts.rateLimit?.perMs ?? 60_000);
    this.backoff = new Backoff(1000, 60_000, opts.random ?? Math.random);
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? globalThis.fetch;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    const botToken = this.opts.token ?? ctx.env[this.opts.tokenEnv ?? 'SLACK_BOT_TOKEN'];
    if (!botToken) {
      ctx.log.info(`slack adapter idle -- ${this.opts.tokenEnv ?? 'SLACK_BOT_TOKEN'} is not set`);
      return;
    }
    this.botToken = botToken;
    ctx.signal.addEventListener('abort', () => void this.stop(), { once: true });

    await this.resolveBotUserId();

    const signingSecret = this.opts.signingSecret ?? ctx.env[this.opts.signingSecretEnv ?? 'SLACK_SIGNING_SECRET'];
    const appToken = this.opts.appToken ?? ctx.env[this.opts.appTokenEnv ?? 'SLACK_APP_TOKEN'];

    if (signingSecret && ctx.mountHttp) {
      const path = this.opts.eventsPath ?? '/slack/events';
      this.unmount = ctx.mountHttp(path, (req) => this.handleHttpEvent(req, signingSecret));
      ctx.log.info(`slack events api mounted at ${path}`);
      return;
    }
    if (appToken) {
      this.connectLoop = this.runSocketMode(appToken);
      return;
    }
    ctx.log.info('slack adapter idle -- set SLACK_APP_TOKEN for socket mode, or SLACK_SIGNING_SECRET for the events api');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unmount?.();
    this.unmount = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState === socket.OPEN) socket.close(1000, 'husk shutting down');
    else socket?.terminate?.();
    await this.connectLoop?.catch(() => undefined);
  }

  get connected(): boolean {
    return this.socket?.readyState === 1 || this.unmount !== undefined;
  }

  private async resolveBotUserId(): Promise<void> {
    try {
      const res = await this.fetch(`${API}/auth.test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const body = (await res.json()) as { ok?: boolean; user_id?: string; error?: string };
      if (body.ok && body.user_id) this.botUserId = body.user_id;
      else this.ctx?.log.warn(`slack auth.test failed: ${body.error ?? 'unknown'}`);
    } catch (err) {
      this.ctx?.log.debug(`slack auth.test unreachable: ${(err as Error).message}`);
    }
  }

  // -- socket mode ---------------------------------------------------------

  private async runSocketMode(appToken: string): Promise<void> {
    while (!this.stopped) {
      const url = await this.openConnection(appToken);
      if (!url) {
        if (this.stopped) return;
        const delay = this.backoff.next();
        this.ctx?.log.warn(`slack apps.connections.open failed, retrying in ${Math.round(delay / 1000)}s`);
        await sleep(delay, this.ctx?.signal);
        continue;
      }
      await this.pumpSocket(url);
      if (this.stopped) return;
      const delay = this.backoff.next();
      this.ctx?.log.warn(`slack socket closed, reconnecting in ${Math.round(delay / 1000)}s`);
      await sleep(delay, this.ctx?.signal);
    }
  }

  private async openConnection(appToken: string): Promise<string | undefined> {
    try {
      const res = await this.fetch(`${API}/apps.connections.open`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${appToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const body = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!body.ok || !body.url) {
        this.ctx?.log.error(`slack socket mode refused: ${body.error ?? 'unknown'}`);
        return undefined;
      }
      return body.url;
    } catch (err) {
      this.ctx?.log.debug(`slack connection open failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private pumpSocket(url: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let socket: WebSocket;
      try {
        socket = this.opts.createSocket ? this.opts.createSocket(url) : new WebSocket(url);
      } catch (err) {
        this.ctx?.log.error(`slack: could not open the socket: ${(err as Error).message}`);
        resolve();
        return;
      }
      this.socket = socket;

      socket.on('message', (raw: unknown) => {
        let envelope: { type?: string; envelope_id?: string; payload?: { event?: SlackEvent } };
        try {
          envelope = JSON.parse(String(raw)) as typeof envelope;
        } catch {
          return;
        }
        if (envelope.type === 'hello') {
          this.backoff.reset();
          this.ctx?.log.info('slack socket mode connected');
          return;
        }
        if (envelope.type === 'disconnect') {
          socket.close(1000, 'slack asked us to reconnect');
          return;
        }
        // Acknowledge first. Slack redelivers anything unacknowledged within 3s, and
        // an agent run takes far longer than that.
        if (envelope.envelope_id && socket.readyState === 1) {
          socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        }
        const event = envelope.payload?.event;
        if (event) void this.onEvent(event);
      });

      socket.on('close', () => resolve());
      socket.on('error', (err: Error) => this.ctx?.log.debug(`slack socket error: ${err.message}`));
    });
  }

  // -- events api ----------------------------------------------------------

  private async handleHttpEvent(req: InboundHttpRequest, signingSecret: string): Promise<InboundHttpResponse> {
    const check = verifySlackSignature({
      signingSecret,
      rawBody: req.rawBody,
      timestamp: req.headers['x-slack-request-timestamp'],
      signature: req.headers['x-slack-signature'],
    });
    if (!check.ok) return { status: 403, body: { error: check.reason } };

    let body: { type?: string; challenge?: string; event?: SlackEvent; event_id?: string };
    try {
      body = JSON.parse(req.rawBody.toString('utf8')) as typeof body;
    } catch {
      return { status: 400, body: { error: 'body is not json' } };
    }

    if (body.type === 'url_verification' && body.challenge) return { status: 200, body: { challenge: body.challenge } };
    if (body.event) {
      if (body.event_id && !this.seen.claim(`slack:${body.event_id}`)) return { status: 200, body: { ok: true } };
      // Answer inside Slack's 3s budget, then do the slow part.
      void this.onEvent(body.event);
    }
    return { status: 200, body: { ok: true } };
  }

  // -- shared handling -----------------------------------------------------

  /** Exposed for tests: the routing decision, with no network in it. */
  shouldHandle(event: SlackEvent): { handle: boolean; reason?: string } {
    if (event.type !== 'message' && event.type !== 'app_mention') return { handle: false, reason: 'not a message' };
    if (event.bot_id) return { handle: false, reason: 'author is a bot' };
    if (event.subtype) return { handle: false, reason: `subtype ${event.subtype}` };
    if (this.botUserId && event.user === this.botUserId) return { handle: false, reason: 'own message' };
    if (!event.channel) return { handle: false, reason: 'no channel' };
    if (this.channels.size > 0 && !this.channels.has(event.channel)) {
      return { handle: false, reason: 'channel is not on the allowlist' };
    }
    const isDirect = event.channel_type === 'im' || event.channel.startsWith('D');
    const mentioned =
      isDirect || event.type === 'app_mention' || (this.botUserId ? (event.text ?? '').includes(`<@${this.botUserId}>`) : false);
    if (this.mentionOnly && !mentioned) return { handle: false, reason: 'not mentioned' };
    if (!event.text?.trim()) return { handle: false, reason: 'empty text' };
    return { handle: true };
  }

  private async onEvent(event: SlackEvent): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.shouldHandle(event).handle) return;

    const key = `slack:${event.channel}:${event.ts}`;
    if (!this.seen.claim(key)) return;

    const userId = event.user ?? 'unknown';
    const channel = event.channel!;
    if (!this.limiter.allow(userId)) {
      const wait = Math.ceil(this.limiter.retryAfterMs(userId) / 1000);
      await this.postMessage(channel, `Rate limited. Try again in ${wait}s.`, event.thread_ts);
      return;
    }

    const text = stripMention(event.text ?? '', this.botUserId ? [this.botUserId] : []);
    // Slack has no typing API for bots. The equivalent is a placeholder message
    // edited in place, which is also what Slack's own AI apps do.
    const placeholder = await this.postMessage(channel, '_thinking…_', event.thread_ts);
    try {
      const runOpts: Parameters<AdapterContext['run']>[1] = { userId, channelId: channel, signal: ctx.signal };
      if (event.thread_ts) runOpts.threadId = event.thread_ts;
      const answer = await ctx.run(text, runOpts);
      await this.deliver(channel, answer || '(no output)', placeholder, event.thread_ts);
    } catch (err) {
      ctx.log.error(`slack run failed: ${(err as Error).message}`);
      await this.deliver(channel, `Something went wrong: ${(err as Error).message}`, placeholder, event.thread_ts);
    }
  }

  private async deliver(channel: string, text: string, placeholderTs: string | undefined, threadTs?: string): Promise<void> {
    const chunks = chunkMessage(text, MESSAGE_LIMIT);
    if (chunks.length === 0) return;
    if (placeholderTs) await this.updateMessage(channel, placeholderTs, chunks[0]!);
    else await this.postMessage(channel, chunks[0]!, threadTs);
    for (const chunk of chunks.slice(1)) await this.postMessage(channel, chunk, threadTs);
  }

  /** Returns the message ts so it can be edited in place. */
  private async postMessage(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
    try {
      const res = await this.fetch(`${API}/chat.postMessage`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(threadTs ? { channel, text, thread_ts: threadTs } : { channel, text }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string; error?: string };
      if (!body.ok && body.error) this.ctx?.log.debug(`slack chat.postMessage: ${body.error}`);
      return body.ts;
    } catch (err) {
      this.ctx?.log.debug(`slack send failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    try {
      await this.fetch(`${API}/chat.update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, ts, text }),
      });
    } catch (err) {
      this.ctx?.log.debug(`slack update failed: ${(err as Error).message}`);
    }
  }
}
