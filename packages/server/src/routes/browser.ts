import { Buffer } from 'node:buffer';
import { browserFor, closeBrowserFor } from '@husk/browser';
import type { Computer } from '@husk/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../context.js';
import { invalidSpec, notFound } from '../errors.js';

/**
 * The real browser, over HTTP.
 *
 * `POST /v1/computers/:id/browse` (in computers.ts) stays: it is the fetch-and-
 * strip fallback, it needs nothing installed, and it answers in 200ms. These
 * endpoints drive an actual Chromium in the same machine, for the pages the
 * fallback cannot see and the sessions it cannot hold.
 */

const GotoSchema = z
  .object({
    url: z.string().min(1),
    timeoutSec: z.number().int().positive().max(300).optional(),
  })
  .strict();

const RefSchema = z.object({ ref: z.string().min(1) }).strict();

const TypeSchema = z
  .object({
    ref: z.string().min(1),
    text: z.string(),
    submit: z.boolean().optional(),
  })
  .strict();

const SnapshotSchema = z.object({ limit: z.number().int().positive().max(5000).optional() }).strict();

function parseOr422<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw invalidSpec(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return parsed.data;
}

async function mustGet(app: FastifyInstance, id: string): Promise<Computer> {
  const computer = await ctxOf(app).deps.manager.get(id);
  if (!computer) throw notFound('computer', id);
  return computer;
}

export async function browserRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);

  app.post('/v1/computers/:id/browser/goto', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = parseOr422(GotoSchema, req.body);
    const computer = await mustGet(app, id);

    const session = browserFor(computer);
    // The policy check lives in the session, on the parsed URL it then navigates
    // to, so there is no gap between what was authorised and what was loaded.
    const result = await session.goto(body.url, { timeoutMs: (body.timeoutSec ?? 30) * 1000 });
    const page = await session.activePage();
    const out = { url: result.url, loaded: result.loaded, title: await page.title() };
    ctx.bus.emit('computers', 'browsed', { id, url: out.url, status: out.loaded ? 200 : 0 });
    return out;
  });

  app.post('/v1/computers/:id/browser/snapshot', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = parseOr422(SnapshotSchema, req.body);
    const page = await browserFor(await mustGet(app, id)).activePage();
    return { url: await page.url(), nodes: await page.snapshot({ limit: body.limit ?? 400 }) };
  });

  app.post('/v1/computers/:id/browser/click', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = parseOr422(RefSchema, req.body);
    const page = await browserFor(await mustGet(app, id)).activePage();
    await page.click(body.ref);
    await page.waitForLoad(5000);
    return { url: await page.url(), nodes: await page.snapshot({ limit: 400 }) };
  });

  app.post('/v1/computers/:id/browser/type', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = parseOr422(TypeSchema, req.body);
    const page = await browserFor(await mustGet(app, id)).activePage();
    await page.type(body.ref, body.text);
    if (body.submit) {
      await page.press('Enter');
      await page.waitForLoad(10_000);
    }
    return { url: await page.url(), nodes: await page.snapshot({ limit: 400 }) };
  });

  app.get('/v1/computers/:id/browser/screenshot', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const { fullPage } = req.query as { fullPage?: string };
    const page = await browserFor(await mustGet(app, id)).activePage();
    const data = await page.screenshot({ fullPage: fullPage === '1' || fullPage === 'true' });
    // Sent as the image rather than as base64 JSON so the console can point an
    // <img> at it and a human can open the URL.
    return reply.type('image/png').send(Buffer.from(data, 'base64'));
  });

  app.delete('/v1/computers/:id/browser', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    await mustGet(app, id);
    await closeBrowserFor(id);
    return reply.code(204).send();
  });
}
