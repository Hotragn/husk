/**
 * @husk/adapters -- the chat front ends.
 *
 * One interface, four platforms. An adapter translates a platform's message shape
 * into a prompt and a reply, and does nothing else: it never reaches into the
 * store, the computer manager or the HTTP server. Everything it can do arrives
 * through `AdapterContext`.
 *
 * Every adapter no-ops with a single log line when its token is absent, because a
 * server must come up whether or not Discord happens to be configured.
 */

export type {
  Adapter,
  AdapterContext,
  AdapterRunOptions,
  BaseAdapterOptions,
  InboundHttpHandler,
  InboundHttpRequest,
  InboundHttpResponse,
  InboundMessage,
  ReplyHandle,
} from './types.js';

export {
  Backoff,
  IdempotencyCache,
  RateLimiter,
  chunkMessage,
  hmacHex,
  keepTyping,
  safeCompare,
  sleep,
  stripMention,
} from './shared.js';

export { DiscordAdapter } from './discord.js';
export type { DiscordAdapterOptions } from './discord.js';

export { SlackAdapter, verifySlackSignature } from './slack.js';
export type { SlackAdapterOptions, SlackSignatureInput, SlackSignatureResult } from './slack.js';

export { TelegramAdapter } from './telegram.js';
export type { TelegramAdapterOptions } from './telegram.js';

export { WebhookAdapter, verifyWebhookSignature } from './webhook.js';
export type { WebhookAdapterOptions, WebhookSignatureOptions, WebhookVerification } from './webhook.js';

import { DiscordAdapter } from './discord.js';
import { SlackAdapter } from './slack.js';
import { TelegramAdapter } from './telegram.js';
import { WebhookAdapter } from './webhook.js';
import type { Adapter, BaseAdapterOptions } from './types.js';

export type AdapterKind = 'discord' | 'slack' | 'telegram' | 'webhook';

/**
 * Build the adapter a husk's trigger asks for.
 *
 * Returns `undefined` for a trigger type this package does not front, so the
 * caller can iterate a spec's triggers without a switch of its own.
 */
export function createAdapter(kind: string, options: BaseAdapterOptions = {}): Adapter | undefined {
  switch (kind) {
    case 'discord':
      return new DiscordAdapter(options);
    case 'slack':
      return new SlackAdapter(options);
    case 'telegram':
      return new TelegramAdapter(options);
    case 'webhook':
      return new WebhookAdapter(options);
    default:
      return undefined;
  }
}
