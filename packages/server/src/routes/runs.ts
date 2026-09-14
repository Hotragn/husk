import type { FastifyInstance } from 'fastify';
import { ctxOf } from '../context.js';
import { notFound } from '../errors.js';
import { SseStream, pipeSse } from '../sse.js';
import type { RunRequestBody } from '../runner.js';

export async function runRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  const { store, log } = ctx.deps;

  app.post('/v1/husks/:name/run', async (req) => {
    const { name } = req.params as { name: string };
    const { spec } = await store.readHusk(name);
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort(new Error('client disconnected')));
    return ctx.runner.run(spec, (req.body ?? {}) as RunRequestBody, abort.signal);
  });

  app.post('/v1/husks/:name/run/stream', async (req, reply) => {
    const { name } = req.params as { name: string };
    const { spec } = await store.readHusk(name);
    const body = (req.body ?? {}) as RunRequestBody;
    const stream = new SseStream(req, reply);
    await pipeSse(stream, (signal) => ctx.runner.stream(spec, body, signal));
    return reply;
  });

  app.get('/v1/runs', async (req) => {
    const q = req.query as { husk?: string; limit?: string; cursor?: string };
    const opts: { husk?: string; limit?: number; cursor?: string } = {};
    if (q.husk) opts.husk = q.husk;
    if (q.limit) {
      const n = Number.parseInt(q.limit, 10);
      if (Number.isFinite(n)) opts.limit = n;
    }
    if (q.cursor) opts.cursor = q.cursor;
    return store.listRuns(opts);
  });

  app.get('/v1/runs/:runId', async (req) => {
    const { runId } = req.params as { runId: string };
    const summary = await store.readRunSummary(runId);
    if (!summary) throw notFound('run', runId);
    const { result, events } = await store.readRun(runId);
    // A run still in flight has no result yet; the summary stands in so a poller can
    // see status without special-casing a 404.
    return { result: result ?? summary, events };
  });

  app.delete('/v1/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    ctx.runner.cancel(runId);
    const removed = await store.deleteRun(runId);
    if (!removed) throw notFound('run', runId);
    return reply.code(204).send();
  });

  app.post('/v1/runs/:runId/cancel', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const cancelled = ctx.runner.cancel(runId);
    if (!cancelled) {
      const summary = await store.readRunSummary(runId);
      if (!summary) throw notFound('run', runId);
      // Already finished. Idempotent rather than an error: a client racing a
      // completing run should not have to distinguish the two outcomes.
      return reply.code(202).send({ runId, cancelled: false, status: summary.status });
    }
    log.info(`cancelled run ${runId}`);
    return reply.code(202).send({ runId, cancelled: true, status: 'aborted' });
  });
}
