import type { HuskSpec, Trigger } from '@husk/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ctxOf } from '../context.js';
import type { ServerContext } from '../context.js';
import { SseStream, pipeSse } from '../sse.js';
import { CronBindings } from './cron.js';
import { extractInput, headerString, mountKey, wantsStream } from './http.js';
import type { HttpMount } from './http.js';
import { verifyHmacSignature } from './webhook.js';

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
  private mounted: MountedTrigger[] = [];

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
  async sync(): Promise<MountedTrigger[]> {
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

    for (const spec of specs) {
      for (const trigger of spec.triggers) {
        if (trigger.type === 'http') {
          const key = mountKey(spec.name, trigger.path);
          this.httpMounts.set(key, { husk: spec.name, auth: trigger.auth });
          mounted.push({ husk: spec.name, type: 'http', at: `/v1/t${key}`, detail: `auth=${trigger.auth}` });
        } else if (trigger.type === 'webhook') {
          const key = mountKey(spec.name, trigger.path);
          const entry: { husk: string; secret?: string } = { husk: spec.name };
          if (trigger.secret) entry.secret = trigger.secret;
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
        }
      }
    }

    this.cron.retain(keepCron);
    this.mounted = mounted;
    this.ctx.bus.emit('triggers', 'triggers_synced', { count: mounted.length, triggers: mounted });
    return mounted;
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

    this.app.get('/v1/triggers', async () => ({ triggers: this.list(), cron: this.cron.list() }));
  }

  start(): void {
    this.ctx.scheduler.start();
  }

  stop(): void {
    this.ctx.scheduler.stop();
    this.cron.clear();
  }
}

export function createTriggerHost(app: FastifyInstance): TriggerHost {
  const ctx = ctxOf(app);
  const host = new TriggerHost(app, ctx);
  ctx.triggers = host;
  host.register();
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
