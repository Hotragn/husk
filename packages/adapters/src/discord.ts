import { WebSocket } from 'ws';
import { Backoff, IdempotencyCache, RateLimiter, chunkMessage, keepTyping, sleep, stripMention } from './shared.js';
import type { Adapter, AdapterContext, BaseAdapterOptions, InboundMessage } from './types.js';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const API = 'https://discord.com/api/v10';
const MESSAGE_LIMIT = 2000;

/** Gateway opcodes we act on. The rest are ignored by design. */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/**
 * GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
 *
 * MESSAGE_CONTENT is privileged: without it enabled in the Developer Portal every
 * `content` arrives empty and the bot looks broken for a reason nothing logs.
 */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/** Discord closes these permanently. Reconnecting just burns the rate limit. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const FATAL_HINTS: Record<number, string> = {
  4004: 'the bot token is not valid -- check DISCORD_BOT_TOKEN',
  4013: 'invalid gateway intents',
  4014: 'a privileged intent is not enabled -- turn on MESSAGE CONTENT INTENT in the Developer Portal',
};

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author?: { id: string; username?: string; bot?: boolean };
  mentions?: Array<{ id: string }>;
  referenced_message?: { author?: { id: string } };
}

export interface DiscordAdapterOptions extends BaseAdapterOptions {
  /** Injected by tests. Anything with the `ws` surface works. */
  createSocket?: (url: string) => WebSocket;
  /** Injected by tests, so no test ever reaches discord.com. */
  fetchImpl?: typeof fetch;
  gatewayUrl?: string;
  /** Jitter source, so a test can make reconnect timing deterministic. */
  random?: () => number;
}

/**
 * Discord over the raw gateway.
 *
 * discord.js would be ~40 dependencies and a compiled cache layer for what is, at
 * this scale, a JSON socket with a heartbeat. The parts that actually matter --
 * jittered first heartbeat, ack tracking, RESUME with the right sequence, not
 * reconnecting on a fatal close -- are all here and all visible.
 */
export class DiscordAdapter implements Adapter {
  readonly id = 'discord';

  private ctx: AdapterContext | undefined;
  private socket: WebSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private awaitingAck = false;
  private sequence: number | null = null;
  private sessionId: string | undefined;
  private resumeUrl: string | undefined;
  private botUserId: string | undefined;
  private stopped = false;
  private readonly backoff: Backoff;
  private readonly seen = new IdempotencyCache();
  private readonly limiter: RateLimiter;
  private readonly channels: Set<string>;
  private readonly mentionOnly: boolean;
  private token = '';
  private connectLoop: Promise<void> | undefined;

  constructor(private readonly opts: DiscordAdapterOptions = {}) {
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
    const envKey = this.opts.tokenEnv ?? 'DISCORD_BOT_TOKEN';
    const token = this.opts.token ?? ctx.env[envKey];

    // A missing token is the normal state for most installs. It is a one-line note,
    // never a crash: the server must come up whether or not Discord is configured.
    if (!token) {
      ctx.log.info(`discord adapter idle -- ${envKey} is not set`);
      return;
    }
    this.token = token;
    ctx.signal.addEventListener('abort', () => void this.stop(), { once: true });
    this.connectLoop = this.runConnectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState === socket.OPEN) socket.close(1000, 'husk shutting down');
    else socket?.terminate?.();
    await this.connectLoop?.catch(() => undefined);
  }

  /** Exposed so the server can report adapter health without reaching into internals. */
  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  private async runConnectLoop(): Promise<void> {
    while (!this.stopped) {
      const url = this.sessionId && this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : (this.opts.gatewayUrl ?? GATEWAY_URL);
      const fatal = await this.connectOnce(url);
      if (fatal || this.stopped) return;
      const delay = this.backoff.next();
      this.ctx?.log.warn(`discord disconnected, reconnecting in ${Math.round(delay / 1000)}s`);
      await sleep(delay, this.ctx?.signal);
    }
  }

  /** Resolves true when the failure is permanent and the loop must not retry. */
  private connectOnce(url: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (fatal: boolean) => {
        if (settled) return;
        settled = true;
        this.clearHeartbeat();
        resolve(fatal);
      };

      let socket: WebSocket;
      try {
        socket = this.opts.createSocket ? this.opts.createSocket(url) : new WebSocket(url);
      } catch (err) {
        this.ctx?.log.error(`discord: could not open the gateway socket: ${(err as Error).message}`);
        finish(false);
        return;
      }
      this.socket = socket;

      socket.on('message', (raw: unknown) => {
        let payload: { op: number; d?: unknown; s?: number | null; t?: string | null };
        try {
          payload = JSON.parse(String(raw)) as typeof payload;
        } catch {
          return;
        }
        if (typeof payload.s === 'number') this.sequence = payload.s;
        this.handlePayload(payload, socket);
      });

      socket.on('close', (code: number, reason: Buffer | string) => {
        const fatal = FATAL_CLOSE_CODES.has(code);
        if (fatal) {
          this.ctx?.log.error(
            `discord closed the gateway with ${code}: ${FATAL_HINTS[code] ?? String(reason)} -- not reconnecting`,
          );
        }
        // Anything but a resumable close means the session is gone; identifying
        // afresh is correct, and trying to RESUME a dead session loops forever.
        if (code !== 1001 && code !== 1006 && code !== 4000) this.sessionId = undefined;
        finish(fatal);
      });

      socket.on('error', (err: Error) => {
        this.ctx?.log.debug(`discord socket error: ${err.message}`);
      });
    });
  }

  private handlePayload(
    payload: { op: number; d?: unknown; s?: number | null; t?: string | null },
    socket: WebSocket,
  ): void {
    switch (payload.op) {
      case OP.HELLO: {
        const interval = (payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41_250;
        this.startHeartbeat(socket, interval);
        if (this.sessionId && this.sequence !== null) this.sendResume(socket);
        else this.sendIdentify(socket);
        break;
      }
      case OP.HEARTBEAT:
        this.sendHeartbeat(socket);
        break;
      case OP.HEARTBEAT_ACK:
        this.awaitingAck = false;
        break;
      case OP.RECONNECT:
        this.ctx?.log.debug('discord asked us to reconnect');
        socket.close(4000, 'reconnect requested');
        break;
      case OP.INVALID_SESSION: {
        const resumable = payload.d === true;
        if (!resumable) {
          this.sessionId = undefined;
          this.sequence = null;
        }
        // Discord's docs require a 1-5s pause before re-identifying here.
        void sleep(1000 + Math.floor((this.opts.random ?? Math.random)() * 4000)).then(() =>
          socket.close(4000, 'invalid session'),
        );
        break;
      }
      case OP.DISPATCH:
        this.handleDispatch(payload.t ?? '', payload.d);
        break;
      default:
        break;
    }
  }

  private handleDispatch(type: string, data: unknown): void {
    if (type === 'READY') {
      const d = data as { session_id?: string; resume_gateway_url?: string; user?: { id?: string; username?: string } };
      this.sessionId = d.session_id;
      this.resumeUrl = d.resume_gateway_url;
      this.botUserId = d.user?.id;
      this.backoff.reset();
      this.ctx?.log.info(`discord connected as ${d.user?.username ?? this.botUserId ?? 'unknown'}`);
      return;
    }
    if (type === 'RESUMED') {
      this.backoff.reset();
      this.ctx?.log.info('discord session resumed');
      return;
    }
    if (type === 'MESSAGE_CREATE') void this.onMessage(data as DiscordMessage);
  }

  private startHeartbeat(socket: WebSocket, intervalMs: number): void {
    this.clearHeartbeat();
    this.awaitingAck = false;
    // Discord asks for a random offset on the first beat so a fleet of bots
    // reconnecting together does not all beat on the same millisecond.
    const jitter = Math.floor((this.opts.random ?? Math.random)() * intervalMs);
    const first = setTimeout(() => {
      this.sendHeartbeat(socket);
      this.heartbeatTimer = setInterval(() => {
        if (this.awaitingAck) {
          // A missed ack means a zombie connection: the socket looks open and no
          // events arrive. Tearing it down is the only way to notice.
          this.ctx?.log.warn('discord heartbeat was not acknowledged -- resetting the connection');
          socket.close(4000, 'heartbeat ack timeout');
          return;
        }
        this.sendHeartbeat(socket);
      }, intervalMs);
      this.heartbeatTimer.unref?.();
    }, jitter);
    first.unref?.();
    this.heartbeatTimer = first as unknown as ReturnType<typeof setInterval>;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.awaitingAck = false;
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify(payload));
  }

  private sendHeartbeat(socket: WebSocket): void {
    this.awaitingAck = true;
    this.send(socket, { op: OP.HEARTBEAT, d: this.sequence });
  }

  private sendIdentify(socket: WebSocket): void {
    this.send(socket, {
      op: OP.IDENTIFY,
      d: {
        token: this.token,
        intents: INTENTS,
        properties: { os: process.platform, browser: 'husk', device: 'husk' },
      },
    });
  }

  private sendResume(socket: WebSocket): void {
    this.send(socket, {
      op: OP.RESUME,
      d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
    });
  }

  /** Exposed for tests: the routing decision, with no network in it. */
  shouldHandle(msg: DiscordMessage): { handle: boolean; reason?: string } {
    if (msg.author?.bot) return { handle: false, reason: 'author is a bot' };
    if (this.botUserId && msg.author?.id === this.botUserId) return { handle: false, reason: 'own message' };
    if (this.channels.size > 0 && !this.channels.has(msg.channel_id)) {
      return { handle: false, reason: 'channel is not on the allowlist' };
    }
    const isDirect = msg.guild_id === undefined;
    const mentioned =
      isDirect ||
      (this.botUserId !== undefined &&
        ((msg.mentions ?? []).some((m) => m.id === this.botUserId) ||
          msg.referenced_message?.author?.id === this.botUserId));
    if (this.mentionOnly && !mentioned) return { handle: false, reason: 'not mentioned' };
    if (!msg.content?.trim()) return { handle: false, reason: 'empty content' };
    return { handle: true };
  }

  private async onMessage(msg: DiscordMessage): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !msg?.id) return;
    const decision = this.shouldHandle(msg);
    if (!decision.handle) return;
    if (!this.seen.claim(`discord:${msg.id}`)) return;

    const userId = msg.author?.id ?? 'unknown';
    if (!this.limiter.allow(userId)) {
      const wait = Math.ceil(this.limiter.retryAfterMs(userId) / 1000);
      await this.postMessage(msg.channel_id, `Rate limited. Try again in ${wait}s.`);
      return;
    }

    const inbound: InboundMessage = {
      id: msg.id,
      text: stripMention(msg.content, this.botUserId ? [this.botUserId] : []),
      userId,
      channelId: msg.channel_id,
      isDirect: msg.guild_id === undefined,
      mentioned: true,
      raw: msg,
    };
    if (msg.author?.username) inbound.userName = msg.author.username;

    const stopTyping = keepTyping(() => this.postTyping(msg.channel_id));
    try {
      const text = await ctx.run(inbound.text, {
        userId: inbound.userId,
        channelId: inbound.channelId,
        signal: ctx.signal,
      });
      stopTyping();
      for (const chunk of chunkMessage(text || '(no output)', MESSAGE_LIMIT)) {
        await this.postMessage(msg.channel_id, chunk);
      }
    } catch (err) {
      stopTyping();
      ctx.log.error(`discord run failed: ${(err as Error).message}`);
      await this.postMessage(msg.channel_id, `Something went wrong: ${(err as Error).message}`);
    }
  }

  private async postMessage(channelId: string, content: string): Promise<void> {
    try {
      const res = await this.fetch(`${API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(Math.ceil((body.retry_after ?? 1) * 1000));
        await this.fetch(`${API}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
      }
    } catch (err) {
      this.ctx?.log.debug(`discord send failed: ${(err as Error).message}`);
    }
  }

  private async postTyping(channelId: string): Promise<void> {
    await this.fetch(`${API}/channels/${channelId}/typing`, {
      method: 'POST',
      headers: { Authorization: `Bot ${this.token}` },
    }).catch(() => undefined);
  }
}
