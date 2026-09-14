import { IdempotencyCache, RateLimiter, hmacHex, safeCompare } from './shared.js';
import type {
  Adapter,
  AdapterContext,
  BaseAdapterOptions,
  InboundHttpRequest,
  InboundHttpResponse,
} from './types.js';

export interface WebhookVerification {
  ok: boolean;
  reason?: string;
}

export interface WebhookSignatureOptions {
  secret: string;
  rawBody: Buffer | string;
  signature: string | undefined;
  /** When set, `timestamp` is required and must be inside this many seconds. */
  toleranceSec?: number;
  timestamp?: string | undefined;
  now?: () => number;
}

/**
 * Verify `X-Husk-Signature: sha256=<hex>` over the raw body.
 *
 * Optionally binds a timestamp into the signed payload. Without that, a captured
 * request is replayable for as long as the secret lives, which for most webhook
 * integrations is forever.
 */
export function verifyWebhookSignature(opts: WebhookSignatureOptions): WebhookVerification {
  if (!opts.signature) return { ok: false, reason: 'missing signature header' };

  if (opts.toleranceSec !== undefined) {
    if (!opts.timestamp) return { ok: false, reason: 'missing timestamp header' };
    const ts = Number.parseInt(opts.timestamp, 10);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp is not a unix time' };
    const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
    if (Math.abs(nowSec - ts) > opts.toleranceSec) return { ok: false, reason: 'timestamp outside the replay window' };
  }

  const body = typeof opts.rawBody === 'string' ? opts.rawBody : opts.rawBody.toString('utf8');
  const signed = opts.timestamp !== undefined ? `${opts.timestamp}.${body}` : body;
  const supplied = opts.signature.includes('=') ? opts.signature.slice(opts.signature.indexOf('=') + 1) : opts.signature;
  return safeCompare(hmacHex(opts.secret, signed), supplied.trim().toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'signature does not match' };
}

export interface WebhookAdapterOptions extends BaseAdapterOptions {
  /** Route to mount, relative to the host's inbound prefix. */
  path?: string;
  secretEnv?: string;
  secret?: string;
  /** Require and verify a timestamp header. Off by default; senders vary. */
  toleranceSec?: number;
  /** Field to read the prompt from, when the payload is JSON. */
  inputField?: string;
  /** Reply synchronously with the run result, or 202 and drop the answer. */
  respondWithResult?: boolean;
}

/**
 * The generic inbound webhook.
 *
 * This is the escape hatch for every platform that does not have a first-class
 * adapter: a CI system, an alerting rule, a Zapier step. It verifies an HMAC,
 * de-duplicates on a delivery id, rate limits per sender, and hands the payload to
 * the husk.
 */
export class WebhookAdapter implements Adapter {
  readonly id = 'webhook';

  private ctx: AdapterContext | undefined;
  private unmount: (() => void) | undefined;
  private secret: string | undefined;
  private readonly seen = new IdempotencyCache();
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: WebhookAdapterOptions = {}) {
    this.limiter = new RateLimiter(opts.rateLimit?.messages ?? 30, opts.rateLimit?.perMs ?? 60_000);
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    if (!ctx.mountHttp) {
      ctx.log.info('webhook adapter idle -- this host does not expose inbound http');
      return;
    }
    this.secret = this.opts.secret ?? ctx.env[this.opts.secretEnv ?? 'HUSK_WEBHOOK_SECRET'];
    if (!this.secret) {
      // Unsigned means anyone who learns the URL can spend your model budget. It is
      // allowed for local testing, and it is said out loud.
      ctx.log.warn(`webhook adapter mounted UNSIGNED -- set ${this.opts.secretEnv ?? 'HUSK_WEBHOOK_SECRET'} to require a signature`);
    }
    const path = this.opts.path ?? `/webhook/${ctx.husk}`;
    this.unmount = ctx.mountHttp(path, (req) => this.handle(req));
    ctx.log.info(`webhook adapter mounted at ${path}`);
  }

  async stop(): Promise<void> {
    this.unmount?.();
    this.unmount = undefined;
  }

  get connected(): boolean {
    return this.unmount !== undefined;
  }

  private async handle(req: InboundHttpRequest): Promise<InboundHttpResponse> {
    const ctx = this.ctx;
    if (!ctx) return { status: 503, body: { error: 'adapter is not started' } };
    if (req.method !== 'POST') {
      return { status: 405, body: { error: { code: 'E_EXEC_DENIED', message: 'use POST', hint: 'webhooks are POST-only' } } };
    }

    if (this.secret) {
      const check = verifyWebhookSignature({
        secret: this.secret,
        rawBody: req.rawBody,
        signature: req.headers['x-husk-signature'] ?? req.headers['x-hub-signature-256'],
        ...(this.opts.toleranceSec !== undefined
          ? { toleranceSec: this.opts.toleranceSec, timestamp: req.headers['x-husk-timestamp'] }
          : {}),
      });
      if (!check.ok) {
        return {
          status: 403,
          body: {
            error: {
              code: 'E_EXEC_DENIED',
              message: `webhook rejected: ${check.reason}`,
              hint: 'X-Husk-Signature: sha256=<hmac-sha256 of the raw body>',
            },
          },
        };
      }
    }

    const deliveryId =
      req.headers['x-husk-delivery'] ?? req.headers['x-github-delivery'] ?? req.headers['idempotency-key'];
    if (deliveryId && !this.seen.claim(`webhook:${deliveryId}`)) {
      return { status: 200, body: { ok: true, deduplicated: true } };
    }

    const sender = req.headers['x-husk-sender'] ?? deliveryId ?? 'anonymous';
    if (!this.limiter.allow(sender)) {
      return {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(this.limiter.retryAfterMs(sender) / 1000)) },
        body: { error: { code: 'E_QUOTA', message: 'rate limited', hint: 'slow down or raise the adapter rateLimit' } },
      };
    }

    const input = this.extractInput(req);
    if (!input) {
      return {
        status: 422,
        body: {
          error: {
            code: 'E_SPEC_INVALID',
            message: 'no prompt found in the payload',
            hint: `send { "${this.opts.inputField ?? 'input'}": "..." } or a raw text body`,
          },
        },
      };
    }

    if (this.opts.respondWithResult === false) {
      void ctx.run(input, { userId: sender, channelId: 'webhook', signal: ctx.signal }).catch((err: unknown) => {
        ctx.log.error(`webhook run failed: ${(err as Error).message}`);
      });
      return { status: 202, body: { ok: true, accepted: true } };
    }

    try {
      const text = await ctx.run(input, { userId: sender, channelId: 'webhook', signal: ctx.signal });
      return { status: 200, body: { ok: true, text } };
    } catch (err) {
      ctx.log.error(`webhook run failed: ${(err as Error).message}`);
      return { status: 500, body: { error: { code: 'E_INTERNAL', message: (err as Error).message } } };
    }
  }

  private extractInput(req: InboundHttpRequest): string | undefined {
    const field = this.opts.inputField ?? 'input';
    const fromQuery = req.query[field] ?? req.query['input'] ?? req.query['text'];
    if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery;

    const text = req.rawBody.toString('utf8');
    if (!text.trim()) return undefined;

    const contentType = req.headers['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        for (const key of [field, 'input', 'text', 'message', 'prompt', 'content']) {
          const v = parsed[key];
          if (typeof v === 'string' && v.trim()) return v;
        }
        // A payload we do not recognise is still information. Handing the husk the
        // whole document beats dropping the event.
        return text;
      } catch {
        return text;
      }
    }
    return text;
  }
}
