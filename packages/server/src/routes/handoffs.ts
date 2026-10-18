import { Buffer } from 'node:buffer';
import { livePageFor } from '@husk-ai/browser';
import type { Page } from '@husk-ai/browser';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../context.js';
import { huskError, invalidSpec } from '../errors.js';

/** Viewport coordinates in CSS pixels. Bounded so nothing absurd reaches Chromium. */
const coord = z.number().finite().min(0).max(20_000);

/**
 * What a person may do to the page. A closed list: mouse, wheel, text and a
 * handful of named keys. There is deliberately no navigate, no script and no
 * raw CDP -- a person gets a mouse and a keyboard, not the debugger.
 */
const InputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('click'),
      x: coord,
      y: coord,
      button: z.enum(['left', 'right']).optional(),
      double: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('scroll'),
      x: coord,
      y: coord,
      dx: z.number().finite().min(-5000).max(5000).optional(),
      dy: z.number().finite().min(-5000).max(5000),
    })
    .strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }).strict(),
  z
    .object({
      type: z.literal('key'),
      key: z.enum([
        'Enter',
        'Tab',
        'Escape',
        'Backspace',
        'Delete',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ]),
    })
    .strict(),
]);

export async function handoffRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);

  /** The page the person needs, scoped to an open handoff. Never launches a browser. */
  const pageFor = (handoffId: string): Page => {
    const handoff = ctx.runner.handoffs.get(handoffId);
    const page = handoff.computerId ? livePageFor(handoff.computerId) : undefined;
    if (!page) {
      throw huskError('E_BROWSER_NOT_FOUND', 'there is no open browser for this handoff', {
        hint: 'the run has not opened a browser, or it was closed; finish the step another way and press done',
      });
    }
    return page;
  };

  app.get('/v1/handoffs', async () => ({ handoffs: ctx.runner.handoffs.list() }));

  app.get('/v1/handoffs/:handoffId/screen', async (req: FastifyRequest, reply: FastifyReply) => {
    const { handoffId } = req.params as { handoffId: string };
    const frame = await pageFor(handoffId).frame();
    // The viewport rides in a header so a click on the image maps back to CSS
    // pixels whatever the device scale. no-store: a login page is not for caches.
    return reply
      .header('cache-control', 'no-store')
      .header('x-husk-viewport', `${frame.width}x${frame.height}`)
      .type('image/jpeg')
      .send(Buffer.from(frame.data, 'base64'));
  });

  // Input is never logged or put on the event bus: a person typing here is
  // usually typing a password or a one-time code.
  app.post('/v1/handoffs/:handoffId/input', async (req: FastifyRequest, reply: FastifyReply) => {
    const { handoffId } = req.params as { handoffId: string };
    const parsed = InputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidSpec(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
    }
    const page = pageFor(handoffId);
    const input = parsed.data;
    if (input.type === 'click') {
      await page.clickAt(input.x, input.y, { button: input.button ?? 'left', clickCount: input.double ? 2 : 1 });
    } else if (input.type === 'scroll') {
      await page.wheelAt(input.x, input.y, input.dx ?? 0, input.dy);
    } else if (input.type === 'text') {
      await page.insertText(input.text);
    } else {
      await page.press(input.key);
    }
    return reply.code(204).send();
  });

  // The only request that resumes a run that asked for a person. Auth is the
  // server-wide bearer check, so this is never reachable without the token.
  app.post('/v1/handoffs/:handoffId/done', async (req) => {
    const { handoffId } = req.params as { handoffId: string };
    const pending = ctx.runner.handoffs.complete(handoffId);
    ctx.bus.emit('runs', 'handoff_completed', pending);
    return { handoffId, outcome: 'done' };
  });
}
