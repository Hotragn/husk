import { Buffer } from 'node:buffer';
import { livePageFor } from '@husk-ai/browser';
import type { Page } from '@husk-ai/browser';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../context.js';
import { redact } from '@husk-ai/core';
import { huskError, invalidSpec, notFound } from '../errors.js';
import type { HandoffRegistry, PendingHandoff } from '../handoffs.js';

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

export interface HandoffRouteOptions {
  registry: HandoffRegistry;
  /**
   * For a viewer that is not behind the server-wide token: whether this request
   * may open this handoff. Without it, the caller's auth is all there is.
   */
  authorize?: (req: FastifyRequest, handoff: PendingHandoff) => boolean;
  /** Apply `authorize` only to requests a link token let in; the server token sees every handoff. */
  scopedOnly?: boolean;
  onDone?: (handoff: PendingHandoff) => void;
}

/** Whether a link's scope covers this handoff: its own key, or its computer's. */
export function scopeCovers(scope: string | undefined, handoff: PendingHandoff): boolean {
  return (handoff.computerId !== undefined && scope === `computer:${handoff.computerId}`) || scope === `handoff:${handoff.handoffId}`;
}

/** The control plane: behind the server-wide bearer token, and every handoff listed. */
export async function handoffRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  app.get('/v1/handoffs', async () => ({ handoffs: ctx.runner.handoffs.list() }));
  registerHandoffRoutes(app, {
    registry: ctx.runner.handoffs,
    authorize: (req, h) => scopeCovers(req.huskScope, h),
    scopedOnly: true,
    onDone: (pending) => ctx.bus.emit('runs', 'handoff_completed', pending),
  });

  // -- a chat's handoffs ---------------------------------------------------
  //
  // A chat's MCP process asks here, so the person takes over in the one console
  // that holds the chat's browser, and the overview and Husk Bar see it waiting.

  /** Ends every chat handoff when the server closes, so none is left holding a computer. */
  const chatHandoffs = new AbortController();
  const Opened = z.object({ reason: z.string().trim().min(1).max(500), label: z.string().max(120).optional() }).strict();

  app.post('/v1/computers/:id/handoffs', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const parsed = Opened.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidSpec(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
    if (!(await ctx.deps.manager.get(id))) throw notFound('computer', id);
    if (ctx.runner.handoffs.list().some((h) => h.computerId === id)) {
      throw huskError('E_EXEC_DENIED', 'this computer is already waiting for a person', { hint: 'finish that handoff first' });
    }
    let opened: PendingHandoff | undefined;
    void ctx.runner.handoffs
      .request({ runId: 'chat', husk: parsed.data.label ?? 'chat', reason: redact(parsed.data.reason), computerId: id, signal: chatHandoffs.signal }, (p) => {
        opened = p;
      })
      .then((outcome) => ctx.bus.emit('runs', outcome === 'done' ? 'handoff_completed' : 'handoff_cancelled', { computerId: id }));
    ctx.bus.emit('runs', 'handoff_requested', opened);
    return reply.code(201).send({ ...opened!, token: ctx.scoped.mint(`computer:${id}`) });
  });

  app.delete('/v1/handoffs/:handoffId', async (req: FastifyRequest) => {
    const { handoffId } = req.params as { handoffId: string };
    if (req.huskScope !== undefined) throw huskError('E_HANDOFF_NOT_FOUND', 'no open handoff with that link');
    return ctx.runner.handoffs.cancel(handoffId);
  });

  // A fresh link to look at one computer, for a chat's card or plain link.
  app.post('/v1/computers/:id/link', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    if (!(await ctx.deps.manager.get(id))) throw notFound('computer', id);
    return { token: ctx.scoped.mint(`computer:${id}`) };
  });

  registerScopedComputerRoutes(app, {
    scopeOf: (req) => req.huskScope ?? undefined,
    describe: async (id) => {
      const c = await ctx.deps.manager.get(id);
      if (!c) return undefined;
      const label = c.info.spec?.labels?.['husk.chat'];
      return { computerId: id, ...(label ? { label } : {}), state: c.info.state };
    },
    registry: ctx.runner.handoffs,
  });
  app.addHook('onClose', async () => chatHandoffs.abort());
}

/** A chat's computer, as its card and its link see it. */
export interface ScopedComputer {
  computerId: string;
  label?: string;
  state: string;
}

/**
 * What a computer link opens: the computer's state and the handoff waiting on
 * it, and a read-only look at its browser. Taking over goes through a handoff.
 * Shared by the control plane and the per-chat viewer.
 */
export function registerScopedComputerRoutes(
  app: FastifyInstance,
  opts: { scopeOf: (req: FastifyRequest) => string | undefined; describe: (id: string) => Promise<ScopedComputer | undefined>; registry: HandoffRegistry },
): void {
  const notYours = () =>
    huskError('E_COMPUTER_NOT_FOUND', 'no computer with that link', {
      hint: 'the link has expired; ask your AI chat to open the computer again',
    });
  const computerOf = (req: FastifyRequest): string => {
    const scope = opts.scopeOf(req);
    if (!scope?.startsWith('computer:')) throw notYours();
    return scope.slice('computer:'.length);
  };
  app.get('/v1/scoped/computer', async (req) => {
    const id = computerOf(req);
    const computer = await opts.describe(id);
    if (!computer) throw notYours();
    return { ...computer, handoff: opts.registry.list().find((h) => h.computerId === id) ?? null };
  });
  app.get('/v1/scoped/computer/screen', async (req, reply) => {
    const page = livePageFor(computerOf(req));
    if (!page) {
      throw huskError('E_BROWSER_NOT_FOUND', 'this computer has no browser open', {
        hint: 'nothing to show until your AI opens a page',
      });
    }
    const frame = await page.frame();
    return reply
      .header('cache-control', 'no-store')
      .header('x-husk-viewport', `${frame.width}x${frame.height}`)
      .type('image/jpeg')
      .send(Buffer.from(frame.data, 'base64'));
  });
}

/** One handoff's view, input and done. Never a list: a key opens one handoff. */
export function registerHandoffRoutes(app: FastifyInstance, opts: HandoffRouteOptions): void {
  const { registry } = opts;

  /** The open handoff, if this request may open it. Not allowed looks the same as not there. */
  const open = (req: FastifyRequest): PendingHandoff => {
    const { handoffId } = req.params as { handoffId: string };
    // Behind the server token: the plain 404, whose hint points at the list.
    // A link token on the control plane is checked like the viewer's.
    if (!opts.authorize || (opts.scopedOnly && req.huskScope === undefined)) return registry.get(handoffId);
    const handoff = registry.isOpen(handoffId) ? registry.get(handoffId) : undefined;
    if (!handoff || !opts.authorize(req, handoff)) {
      throw huskError('E_HANDOFF_NOT_FOUND', 'no open handoff with that link', {
        hint: 'the handoff has ended, or the link has expired; ask your AI chat for a new one',
      });
    }
    return handoff;
  };

  /** The page the person needs, scoped to an open handoff. Never launches a browser. */
  const pageFor = (req: FastifyRequest): Page => {
    const handoff = open(req);
    const page = handoff.computerId ? livePageFor(handoff.computerId) : undefined;
    if (!page) {
      throw huskError('E_BROWSER_NOT_FOUND', 'there is no open browser for this handoff', {
        hint: 'the run has not opened a browser, or it was closed; finish the step another way and press done',
      });
    }
    return page;
  };

  app.get('/v1/handoffs/:handoffId', async (req: FastifyRequest) => open(req));

  app.get('/v1/handoffs/:handoffId/screen', async (req: FastifyRequest, reply: FastifyReply) => {
    const frame = await pageFor(req).frame();
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
    const parsed = InputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidSpec(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
    }
    const page = pageFor(req);
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

  // The only request that resumes a run that asked for a person.
  app.post('/v1/handoffs/:handoffId/done', async (req: FastifyRequest) => {
    const pending = registry.complete(open(req).handoffId);
    opts.onDone?.(pending);
    return { handoffId: pending.handoffId, outcome: 'done' };
  });
}
