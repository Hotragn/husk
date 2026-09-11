import { safeParseSpec } from '@husk/core';
import type { FastifyInstance } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { ctxOf } from '../context.js';
import { huskError, notFound } from '../errors.js';

function readSpecInput(body: unknown): unknown {
  const b = (body ?? {}) as { spec?: unknown; yaml?: unknown };
  if (typeof b.yaml === 'string') {
    try {
      return parseYaml(b.yaml) as unknown;
    } catch (err) {
      throw huskError('E_SPEC_INVALID', `yaml did not parse: ${(err as Error).message}`, {
        hint: 'check indentation -- husk.yaml is YAML, and tabs are not valid indentation',
        cause: err,
      });
    }
  }
  if (b.spec === undefined) {
    throw huskError('E_SPEC_INVALID', 'body must carry either `spec` or `yaml`', {
      hint: 'POST { "yaml": "name: my-bot\\npersona: ..." } or { "spec": { ... } }',
    });
  }
  return b.spec;
}

export async function huskRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  const { store } = ctx.deps;

  app.get('/v1/husks', async () => ({ husks: await store.listHusks() }));

  app.get('/v1/husks/:name', async (req) => {
    const { name } = req.params as { name: string };
    return store.readHusk(name);
  });

  app.post('/v1/husks', async (req, reply) => {
    const { spec, yaml } = store.parseHuskInput(req.body);
    const existing = await store.tryReadHusk(spec.name);
    const summary = await store.writeHusk(spec, yaml);
    ctx.bus.emit('triggers', existing ? 'husk_updated' : 'husk_created', summary);
    await ctx.triggers?.sync();
    return reply.code(201).send(summary);
  });

  app.put('/v1/husks/:name', async (req) => {
    const { name } = req.params as { name: string };
    const { spec, yaml } = store.parseHuskInput(req.body);
    if (spec.name !== name) {
      throw huskError('E_SPEC_INVALID', `spec name "${spec.name}" does not match the path /v1/husks/${name}`, {
        hint: 'rename by DELETE-ing the old husk and POST-ing the new one',
      });
    }
    await store.readHusk(name);
    const summary = await store.writeHusk(spec, yaml);
    ctx.bus.emit('triggers', 'husk_updated', summary);
    await ctx.triggers?.sync();
    return summary;
  });

  app.delete('/v1/husks/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const removed = await store.deleteHusk(name);
    if (!removed) throw notFound('husk', name);
    ctx.bus.emit('triggers', 'husk_deleted', { name });
    await ctx.triggers?.sync();
    return reply.code(204).send();
  });
}

/**
 * Registered ahead of the resource routes so `/v1/husks/validate` is not swallowed
 * by `/v1/husks/:name`, and so validation can answer `{ ok: false, issues }` with a
 * 200 rather than the 422 the shared spec parser would throw.
 */
export async function huskValidateRoute(app: FastifyInstance): Promise<void> {
  app.post('/v1/husks/validate', async (req) => {
    let raw: unknown;
    try {
      raw = readSpecInput(req.body);
    } catch (err) {
      return { ok: false, issues: [(err as Error).message] };
    }
    const parsed = safeParseSpec(raw);
    return parsed.ok ? { ok: true } : { ok: false, issues: parsed.issues };
  });
}
