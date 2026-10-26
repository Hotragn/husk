import type { Adapter, InboundHttpHandler } from '@husk-ai/adapters';
import { expandEnvRefs } from '@husk-ai/core';
import type { HuskSpec, Trigger } from '@husk-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ctxOf } from '../context.js';
import type { ServerContext } from '../context.js';
import { SseStream, pipeSse } from '../sse.js';
import { CronBindings } from './cron.js';
import { extractInput, headerString, mountKey, wantsStream } from './http.js';
import type { HttpMount } from './http.js';
import { verifyHmacSignature } from './webhook.js';

type ChatTrigger = Extract<Trigger, { type: 'discord' | 'slack' | 'telegram' }>;

const TOKEN_ENV: Record<ChatTrigger['type'], string> = {
  discord: 'DISCORD_BOT_TOKEN',
  slack: 'SLACK_BOT_TOKEN',
  telegram: 'TELEGRAM_BOT_TOKEN',
};

export interface MountedTrigger {
  husk: string;
  type: Trigger['type'];
  /** The route or schedule this trigger answers on. */
  at: string;
  detail?: string;
}

/**
 * Mounts each husk's declared triggers onto the running server.
 *
 * Fastify cannot unregister a route once it is added, so the per-husk endpoints are
 * two wildcard routes registered at boot that dispatch through tables `sync()`
 * rebuilds. Editing a husk.yaml therefore takes effect without a restart, and a
 * deleted husk stops answering immediately rather than 500-ing on a dead handler.
 */
export class TriggerHost {
  private readonly httpMounts = new Map<string, HttpMount>();
  private readonly webhookMounts = new Map<string, { husk: string; secret?: string }>();
  private readonly cron: CronBindings;
  /** Running chat adapters, keyed `husk:type`, with the trigger they were built from. */
  private readonly adapters = new Map<string, { adapter: Adapter; controller: AbortController; config: string }>();
  /** Inbound HTTP routes an adapter mounted (Slack's Events API), under /v1/a. */
  private readonly adapterRoutes = new Map<string, InboundHttpHandler>();
  private mounted: MountedTrigger[] = [];
  private syncing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly app: FastifyInstance,
    private readonly ctx: ServerContext,
  ) {
    this.cron = new CronBindings(ctx.scheduler, (husk, prompt) => this.fireCron(husk, prompt));
  }

  list(): MountedTrigger[] {
    return [...this.mounted];
  }

  /** Rebuild the routing tables from what is on disk. Safe to call repeatedly. */
  /**
   * Rebuild from disk. Calls run one at a time: two husk saves close together
   * used to race, and both could start an adapter for the same trigger.
   */
  sync(): Promise<MountedTrigger[]> {
    const run = this.syncing.then(() => this.doSync());
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async doSync(): Promise<MountedTrigger[]> {
    const summaries = await this.ctx.deps.store.listHusks();
    const specs: HuskSpec[] = [];
    for (const summary of summaries) {
      const loaded = await this.ctx.deps.store.tryReadHusk(summary.name);
      if (loaded) specs.push(loaded.spec);
    }

    this.httpMounts.clear();
    this.webhookMounts.clear();
    const keepCron = new Set<string>();
    const mounted: MountedTrigger[] = [];
    const wantAdapters = new Map<string, { husk: string; trigger: ChatTrigger }>();

    for (const spec of specs) {
      for (const trigger of spec.triggers) {
        if (trigger.type === 'http') {
          const key = mountKey(spec.name, trigger.path);
          this.httpMounts.set(key, { husk: spec.name, auth: trigger.auth });
          mounted.push({ husk: spec.name, type: 'http', at: `/v1/t${key}`, detail: `auth=${trigger.auth}` });
        } else if (trigger.type === 'webhook') {
          const key = mountKey(spec.name, trigger.path);
          const entry: { husk: string; secret?: string } = { husk: spec.name };
          try {
            if (trigger.secret) entry.secret = expandEnvRefs(trigger.secret, process.env, `husk ${spec.name}'s webhook secret`);
          } catch (err) {
            // Not mounted at all: mounted unsigned, anyone could start this husk.
            this.ctx.deps.log.error(`${(err as Error).message}; its webhook at /v1/w${key} is not mounted`);
            continue;
          }
          this.webhookMounts.set(key, entry);
          mounted.push({
            husk: spec.name,
            type: 'webhook',
            at: `/v1/w${key}`,
            detail: trigger.secret ? 'hmac-sha256 required' : 'UNSIGNED -- set `secret` on the trigger',
          });
        } else if (trigger.type === 'cron') {
          try {
            const binding = this.cron.add(spec.name, trigger.schedule, trigger.prompt);
            keepCron.add(binding.jobId);
            mounted.push({
              husk: spec.name,
              type: 'cron',
              at: trigger.schedule,
              detail: binding.nextAt ? `next ${binding.nextAt}` : 'never fires',
            });
          } catch (err) {
            // A bad schedule disables that one job, loudly. The other husks on this
            // server keep working.
            this.ctx.deps.log.error(`husk ${spec.name}: ${(err as Error).message}`);
          }
        } else if (trigger.type === 'discord' || trigger.type === 'slack' || trigger.type === 'telegram') {
          const key = `${spec.name}:${trigger.type}`;
          if (wantAdapters.has(key)) {
            this.ctx.deps.log.error(`husk ${spec.name}: a second ${trigger.type} trigger was ignored; one per husk`);
            continue;
          }
          wantAdapters.set(key, { husk: spec.name, trigger });
        }
        // `cli` triggers mean `husk run` and need nothing mounted.
      }
    }

    mounted.push(...(await this.syncAdapters(wantAdapters)));
    this.cron.retain(keepCron);
    this.mounted = mounted;
    this.ctx.bus.emit('triggers', 'triggers_synced', { count: mounted.length, triggers: mounted });
    return mounted;
  }


  /**
   * Start, keep or stop chat adapters so they match the husks on disk. An adapter
   * whose trigger did not change keeps running, so a sync never drops a Discord
   * gateway connection for an unrelated edit.
   */
  private async syncAdapters(want: Map<string, { husk: string; trigger: ChatTrigger }>): Promise<MountedTrigger[]> {
    for (const [key, running] of this.adapters) {
      const next = want.get(key);
      if (next && JSON.stringify(next.trigger) === running.config) continue;
      this.adapters.delete(key);
      running.controller.abort();
      await running.adapter.stop().catch((err) => this.ctx.deps.log.warn(`stopping ${key}: ${(err as Error).message}`));
      const cut = key.lastIndexOf(':');
      this.ctx.bus.emit('adapters', 'adapter_stopped', { husk: key.slice(0, cut), type: key.slice(cut + 1) });
    }

    const mounted: MountedTrigger[] = [];
    if (!this.ctx.deps.config.adapters) return mounted;
    // One bot token per platform, so one husk per platform: two Discord
    // sessions on one token answer every message twice, and two Telegram
    // pollers fight with 409s.
    const platformOwner = new Map<string, string>();
    for (const [key, { husk, trigger }] of want) {
      const owner = platformOwner.get(trigger.type);
      if (owner && owner !== husk) {
        this.ctx.deps.log.error(`husk ${husk}: ${trigger.type} is already used by husk ${owner}; one husk per platform, so this one was not started`);
        mounted.push({ husk, type: trigger.type, at: trigger.type, detail: `not started -- husk ${owner} already uses ${trigger.type}` });
        continue;
      }
      platformOwner.set(trigger.type, husk);

      // Answering anyone is not a default: the bot runs commands on a computer.
      const open =
        trigger.type === 'telegram' ? trigger.allowlist.length === 0 : trigger.channels.length === 0;
      if (open) {
        const need = trigger.type === 'telegram' ? 'allowlist (usernames or ids)' : 'channels (channel ids)';
        this.ctx.deps.log.error(`husk ${husk}: the ${trigger.type} trigger needs a ${need}; with none it would answer anyone, so it was not started`);
        mounted.push({ husk, type: trigger.type, at: trigger.type, detail: `not started -- set ${need}` });
        continue;
      }

      const env = process.env;
      const tokenEnv = TOKEN_ENV[trigger.type];
      const detail = env[tokenEnv] ? `${tokenEnv} is set` : `idle -- ${tokenEnv} is not set`;
      mounted.push({ husk, type: trigger.type, at: trigger.type, detail });
      if (this.adapters.has(key)) continue;

      const options =
        trigger.type === 'telegram'
          ? { allowlist: trigger.allowlist }
          : { channels: trigger.channels, mentionOnly: trigger.mentionOnly };
      const adapter = this.ctx.deps.createAdapter(trigger.type, options);
      if (!adapter) continue;
      const controller = new AbortController();
      // Reserved before starting, and started in the background: Slack's and
      // Telegram's start make a network call, and a slow network must not hold
      // up `husk serve` coming up or an unrelated husk being saved.
      this.adapters.set(key, { adapter, controller, config: JSON.stringify(trigger) });
      void adapter
        .start({
          husk,
          log: this.ctx.deps.log,
          signal: controller.signal,
          env,
          run: (input, opts) => this.runAdapter(husk, input, opts.signal),
          mountHttp: (path, handler) => {
            const route = `/${husk}${path}`;
            this.adapterRoutes.set(route, handler);
            return () => this.adapterRoutes.delete(route);
          },
        })
        .then(
          () => this.ctx.bus.emit('adapters', 'adapter_started', { husk, type: trigger.type }),
          (err: unknown) => {
            // One bad adapter takes out that trigger, loudly; the others keep working.
            if (this.adapters.get(key)?.adapter === adapter) this.adapters.delete(key);
            controller.abort();
            this.ctx.deps.log.error(`husk ${husk}: the ${trigger.type} trigger did not start: ${(err as Error).message}`);
          },
        );
    }
    return mounted;
  }

  private async runAdapter(husk: string, input: string, signal?: AbortSignal): Promise<string> {
    const loaded = await this.ctx.deps.store.tryReadHusk(husk);
    if (!loaded) throw new Error(`no husk named ${husk}`);
    const result = await this.ctx.runner.run(loaded.spec, { input }, signal);
    return result.text || '(the agent produced no text)';
  }

  private async fireCron(husk: string, prompt: string): Promise<void> {
    const loaded = await this.ctx.deps.store.tryReadHusk(husk);
    if (!loaded) return;
    this.ctx.bus.emit('triggers', 'cron_fired', { husk, prompt });
    try {
      await this.ctx.runner.run(loaded.spec, { input: prompt });
    } catch (err) {
      this.ctx.deps.log.error(`cron run for ${husk} failed`, err);
    }
  }

  private missing(reply: FastifyReply, what: string): FastifyReply {
    return reply.code(404).send({
      error: { code: 'E_HUSK_NOT_FOUND', message: what, hint: 'GET /v1/triggers lists what is mounted' },
    });
  }

  private noInput(reply: FastifyReply): FastifyReply {
    return reply.code(422).send({
      error: {
        code: 'E_SPEC_INVALID',
        message: 'no prompt found in the request',
        hint: 'send { "input": "..." }, a raw text body, or ?input=...',
      },
    });
  }

  private async runFor(husk: string, input: string, reply: FastifyReply): Promise<unknown> {
    const loaded = await this.ctx.deps.store.tryReadHusk(husk);
    if (!loaded) return this.missing(reply, `no husk named ${husk}`);
    const result = await this.ctx.runner.run(loaded.spec, { input });
    return { runId: result.runId, text: result.text, stopReason: result.stopReason, usage: result.usage };
  }

  /** Registered once at boot; the dispatch tables behind these are rebuilt by `sync()`. */
  register(): void {
    const lookup = <T>(table: Map<string, T>, req: FastifyRequest): T | undefined => {
      const raw = `/${(req.params as Record<string, string>)['*'] ?? ''}`;
      return table.get(raw.replace(/\/+$/, '') || raw) ?? table.get(raw);
    };

    this.app.all('/v1/t/*', async (req, reply) => {
      const mount = lookup(this.httpMounts, req);
      if (!mount) return this.missing(reply, `no http trigger mounted at ${req.url}`);
      const input = extractInput(req);
      if (!input) return this.noInput(reply);

      if (wantsStream(req)) {
        const loaded = await this.ctx.deps.store.tryReadHusk(mount.husk);
        if (!loaded) return this.missing(reply, `no husk named ${mount.husk}`);
        const stream = new SseStream(req, reply);
        await pipeSse(stream, (signal) => this.ctx.runner.stream(loaded.spec, { input }, signal));
        return reply;
      }
      return this.runFor(mount.husk, input, reply);
    });

    this.app.post('/v1/w/*', async (req, reply) => {
      const mount = lookup(this.webhookMounts, req);
      if (!mount) return this.missing(reply, `no webhook mounted at ${req.url}`);

      if (mount.secret) {
        const check = verifyHmacSignature({
          secret: mount.secret,
          rawBody: req.rawBody ?? Buffer.alloc(0),
          signature:
            headerString(req, 'x-husk-signature') ??
            headerString(req, 'x-hub-signature-256') ??
            headerString(req, 'x-signature-256'),
        });
        if (!check.ok) {
          return reply.code(403).send({
            error: {
              code: 'E_EXEC_DENIED',
              message: `webhook rejected: ${check.reason}`,
              hint: 'sign the raw request body: X-Husk-Signature: sha256=<hmac-sha256 hex>',
            },
          });
        }
      }

      const input = extractInput(req);
      if (!input) return this.noInput(reply);
      return this.runFor(mount.husk, input, reply);
    });

    // Public: the adapter that mounted the route checks the platform's own
    // signature (Slack's signing secret) before anything runs.
    this.app.all('/v1/a/*', async (req, reply) => {
      const handler = lookup(this.adapterRoutes, req);
      if (!handler) return this.missing(reply, `no chat adapter mounted at ${req.url}`);
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value[0] : value;
      const res = await handler({
        method: req.method,
        headers,
        rawBody: req.rawBody ?? Buffer.alloc(0),
        query: req.query as Record<string, string | undefined>,
      });
      if (res.headers) void reply.headers(res.headers);
      return reply.code(res.status).send(res.body ?? '');
    });

    this.app.get('/v1/triggers', async () => ({ triggers: this.list(), cron: this.cron.list() }));
  }

  start(): void {
    this.ctx.scheduler.start();
  }

  stop(): Promise<void> {
    this.ctx.scheduler.stop();
    this.cron.clear();
    return this.stopAdapters();
  }

  /** Close every adapter's socket or poll loop, and wait until they have. */
  async stopAdapters(): Promise<void> {
    const running = [...this.adapters];
    this.adapters.clear();
    await Promise.allSettled(
      running.map(async ([key, r]) => {
        r.controller.abort();
        await r.adapter.stop().catch((err) => this.ctx.deps.log.warn(`stopping ${key}: ${(err as Error).message}`));
      }),
    );
  }
}

export function createTriggerHost(app: FastifyInstance): TriggerHost {
  const ctx = ctxOf(app);
  const host = new TriggerHost(app, ctx);
  ctx.triggers = host;
  host.register();
  app.addHook('onClose', () => host.stopAdapters());
  return host;
}

export { CronBindings } from './cron.js';
export { extractInput, mountKey, wantsStream } from './http.js';
export { hmacHex, safeCompareHex, verifyHmacSignature } from './webhook.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact bytes as received. Required for any signature check. */
    rawBody?: Buffer;
  }
}
