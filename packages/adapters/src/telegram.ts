import { Backoff, IdempotencyCache, RateLimiter, chunkMessage, keepTyping, sleep } from './shared.js';
import type { Adapter, AdapterContext, BaseAdapterOptions } from './types.js';

const MESSAGE_LIMIT = 4096;
/** Long-poll window. Telegram holds the request open until an update arrives. */
const POLL_TIMEOUT_SEC = 25;

interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number; type: string; title?: string };
  from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramAdapterOptions extends BaseAdapterOptions {
  /** Usernames or numeric user ids permitted to talk to the bot. */
  allowlist?: string[];
  apiBase?: string;
  fetchImpl?: typeof fetch;
  random?: () => number;
  pollTimeoutSec?: number;
}

/**
 * Telegram by long polling.
 *
 * Webhooks need a public HTTPS endpoint, which the free path -- a laptop -- does
 * not have. `getUpdates` works from anywhere behind any NAT, and the offset
 * bookkeeping is what makes it exactly-once: an update is only acknowledged by
 * asking for the one after it, so a crash mid-run redelivers rather than drops.
 */
export class TelegramAdapter implements Adapter {
  readonly id = 'telegram';

  private ctx: AdapterContext | undefined;
  private stopped = false;
  private offset = 0;
  private token = '';
  private botUsername: string | undefined;
  private loop: Promise<void> | undefined;
  private inflight: AbortController | undefined;
  private readonly backoff: Backoff;
  private readonly seen = new IdempotencyCache();
  private readonly limiter: RateLimiter;
  private readonly allowlist: Set<string>;

  constructor(private readonly opts: TelegramAdapterOptions = {}) {
    this.allowlist = new Set((opts.allowlist ?? []).map((s) => s.toLowerCase().replace(/^@/, '')));
    this.limiter = new RateLimiter(opts.rateLimit?.messages ?? 5, opts.rateLimit?.perMs ?? 60_000);
    this.backoff = new Backoff(1000, 60_000, opts.random ?? Math.random);
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? globalThis.fetch;
  }

  private url(method: string): string {
    return `${this.opts.apiBase ?? 'https://api.telegram.org'}/bot${this.token}/${method}`;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    const envKey = this.opts.tokenEnv ?? 'TELEGRAM_BOT_TOKEN';
    const token = this.opts.token ?? ctx.env[envKey];
    if (!token) {
      ctx.log.info(`telegram adapter idle -- ${envKey} is not set`);
      return;
    }
    this.token = token;
    ctx.signal.addEventListener('abort', () => void this.stop(), { once: true });

    if (this.allowlist.size === 0) {
      ctx.log.warn('telegram allowlist is empty: anyone who finds this bot can spend your model budget');
    }

    await this.resolveIdentity();
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.inflight?.abort();
    await this.loop?.catch(() => undefined);
  }

  get connected(): boolean {
    return this.loop !== undefined && !this.stopped;
  }

  private async resolveIdentity(): Promise<void> {
    try {
      const res = await this.fetch(this.url('getMe'));
      const body = (await res.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
      if (body.ok && body.result?.username) {
        this.botUsername = body.result.username;
        this.ctx?.log.info(`telegram connected as @${this.botUsername}`);
      } else {
        this.ctx?.log.warn(`telegram getMe failed: ${body.description ?? 'unknown'}`);
      }
    } catch (err) {
      this.ctx?.log.debug(`telegram getMe unreachable: ${(err as Error).message}`);
    }
  }

  private async poll(): Promise<void> {
    const timeout = this.opts.pollTimeoutSec ?? POLL_TIMEOUT_SEC;
    while (!this.stopped) {
      const controller = new AbortController();
      this.inflight = controller;
      try {
        const res = await this.fetch(
          `${this.url('getUpdates')}?timeout=${timeout}&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message"]')}`,
          { signal: controller.signal },
        );
        const body = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[]; description?: string };
        if (!body.ok) {
          this.ctx?.log.warn(`telegram getUpdates: ${body.description ?? 'not ok'}`);
          await sleep(this.backoff.next(), this.ctx?.signal);
          continue;
        }
        this.backoff.reset();
        for (const update of body.result ?? []) {
          // Advance the offset before handling, so a message that makes the agent
          // throw is not retried forever in a loop.
          this.offset = Math.max(this.offset, update.update_id + 1);
          const message = update.message ?? update.edited_message;
          if (message) await this.onMessage(message, update.update_id);
        }
      } catch (err) {
        if (this.stopped) return;
        this.ctx?.log.debug(`telegram poll failed: ${(err as Error).message}`);
        await sleep(this.backoff.next(), this.ctx?.signal);
      } finally {
        this.inflight = undefined;
      }
    }
  }

  /** Exposed for tests: the routing decision, with no network in it. */
  shouldHandle(msg: TelegramMessage): { handle: boolean; reason?: string } {
    if (msg.from?.is_bot) return { handle: false, reason: 'author is a bot' };
    if (!msg.text?.trim()) return { handle: false, reason: 'no text' };

    if (this.allowlist.size > 0) {
      const username = msg.from?.username?.toLowerCase();
      const userId = msg.from?.id !== undefined ? String(msg.from.id) : undefined;
      const chatId = String(msg.chat.id);
      const permitted =
        (username !== undefined && this.allowlist.has(username)) ||
        (userId !== undefined && this.allowlist.has(userId)) ||
        this.allowlist.has(chatId);
      if (!permitted) return { handle: false, reason: 'sender is not on the allowlist' };
    }

    const isDirect = msg.chat.type === 'private';
    const mentioned = isDirect || (this.botUsername ? msg.text.includes(`@${this.botUsername}`) : false);
    if ((this.opts.mentionOnly ?? true) && !mentioned) return { handle: false, reason: 'not mentioned' };
    return { handle: true };
  }

  private async onMessage(msg: TelegramMessage, updateId: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.shouldHandle(msg).handle) return;
    if (!this.seen.claim(`telegram:${updateId}`)) return;

    const userId = msg.from?.id !== undefined ? String(msg.from.id) : String(msg.chat.id);
    if (!this.limiter.allow(userId)) {
      const wait = Math.ceil(this.limiter.retryAfterMs(userId) / 1000);
      await this.send(msg.chat.id, `Rate limited. Try again in ${wait}s.`);
      return;
    }

    const text = this.botUsername ? msg.text!.replaceAll(`@${this.botUsername}`, '').trim() : msg.text!.trim();
    const stopTyping = keepTyping(() => this.chatAction(msg.chat.id), 5000);
    try {
      const answer = await ctx.run(text, {
        userId,
        channelId: String(msg.chat.id),
        signal: ctx.signal,
      });
      stopTyping();
      for (const chunk of chunkMessage(answer || '(no output)', MESSAGE_LIMIT)) {
        await this.send(msg.chat.id, chunk);
      }
    } catch (err) {
      stopTyping();
      ctx.log.error(`telegram run failed: ${(err as Error).message}`);
      await this.send(msg.chat.id, `Something went wrong: ${(err as Error).message}`);
    }
  }

  private async send(chatId: number, text: string): Promise<void> {
    try {
      await this.fetch(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
    } catch (err) {
      this.ctx?.log.debug(`telegram send failed: ${(err as Error).message}`);
    }
  }

  /** Telegram's typing indicator expires after ~5s, hence the short interval. */
  private async chatAction(chatId: number): Promise<void> {
    await this.fetch(this.url('sendChatAction'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch(() => undefined);
  }
}
