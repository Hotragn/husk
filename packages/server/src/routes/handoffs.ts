import { Buffer } from 'node:buffer';
import { livePageFor, markUsedFor } from '@husk-ai/browser';
import type { Page } from '@husk-ai/browser';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../context.js';
import { redact } from '@husk-ai/core';
import { huskError, invalidSpec, notFound } from '../errors.js';
import { PERSON_RUN } from '../handoffs.js';
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
  /**
   * A chat holds its handoff by polling it. One that stops polling for a
   * minute has gone (crashed, killed, closed), and nobody is left to resume:
   * the handoff is cancelled -- never marked done -- so the computer is free.
   */
  const lastSeen = new Map<string, number>();
  const LEASE_MS = 60_000;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [handoffId, seen] of lastSeen) {
      if (now - seen < LEASE_MS) continue;
      lastSeen.delete(handoffId);
      if (ctx.runner.handoffs.isOpen(handoffId)) ctx.runner.handoffs.cancel(handoffId);
    }
  }, 15_000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  // How a chat's handoff stands. The server token only: a link has no business here.
  app.get('/v1/handoffs/:handoffId/state', async (req: FastifyRequest) => {
    if (req.huskScope !== undefined) throw huskError('E_HANDOFF_NOT_FOUND', 'no open handoff with that link');
    const { handoffId } = req.params as { handoffId: string };
    const state = ctx.runner.handoffs.state(handoffId);
    if (state === 'open' && lastSeen.has(handoffId)) lastSeen.set(handoffId, Date.now());
    return { handoffId, state: state ?? 'unknown' };
  });
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
      .then((outcome) => {
        if (opened) lastSeen.delete(opened.handoffId);
        // The link minted for this handoff dies with it; a later handoff mints its own.
        ctx.scoped.revoke(`computer:${id}`);
        ctx.bus.emit('runs', outcome === 'done' ? 'handoff_completed' : 'handoff_cancelled', { computerId: id });
      });
    if (opened) lastSeen.set(opened.handoffId, Date.now());
    ctx.bus.emit('runs', 'handoff_requested', opened);
    return reply.code(201).send({ ...opened!, token: ctx.scoped.mint(`computer:${id}`) });
  });

  // The person takes a computer whenever they choose, from the console or from
  // a chat's link. No lease: only their Give back (done) ends it, or the server
  // closing. Unlike a chat's handoff, ending it revokes no link.
  const take = (id: string) =>
    takeOver(ctx.runner.handoffs, id, chatHandoffs.signal, {
      opened: (h) => ctx.bus.emit('runs', 'handoff_requested', h),
      ended: (outcome) => ctx.bus.emit('runs', outcome === 'done' ? 'handoff_completed' : 'handoff_cancelled', { computerId: id }),
    });
  app.post('/v1/computers/:id/takeover', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!(await ctx.deps.manager.get(id))) throw notFound('computer', id);
    const { handoff, created } = take(id);
    return reply.code(created ? 201 : 200).send(handoff);
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
    takeOver: take,
  });
  app.addHook('onClose', async () => chatHandoffs.abort());
}

/**
 * The person takes a computer: the handoff already waiting on it, which is
 * theirs to finish, or a new one that only their done (or `signal`) ends.
 */
export function takeOver(
  registry: HandoffRegistry,
  computerId: string,
  signal: AbortSignal,
  on: { opened?: (handoff: PendingHandoff) => void; ended?: (outcome: string) => void } = {},
): { handoff: PendingHandoff; created: boolean } {
  const held = registry.list().find((h) => h.computerId === computerId);
  if (held) return { handoff: held, created: false };
  let opened: PendingHandoff | undefined;
  void registry
    .request({ runId: PERSON_RUN, husk: 'you', reason: 'You took over this computer', computerId, signal }, (p) => {
      opened = p;
    })
    .then((outcome) => on.ended?.(outcome));
  on.opened?.(opened!);
  return { handoff: opened!, created: true };
}

/** A chat's computer, as its card and its link see it. */
export interface ScopedComputer {
  computerId: string;
  label?: string;
  state: string;
}

/**
 * What a computer link opens: the computer's state and the handoff waiting on
 * it, a look at its browser, and Take over, which opens a handoff on that one
 * computer. The handoff's own routes (screen, input, done) then work with the
 * same link. Shared by the control plane and the per-chat viewer.
 */
export function registerScopedComputerRoutes(
  app: FastifyInstance,
  opts: {
    scopeOf: (req: FastifyRequest) => string | undefined;
    describe: (id: string) => Promise<ScopedComputer | undefined>;
    registry: HandoffRegistry;
    takeOver: (computerId: string) => { handoff: PendingHandoff; created: boolean };
  },
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
  // The link's own computer, and no other: the id comes from the token, never the request.
  app.post('/v1/scoped/computer/takeover', async (req, reply) => {
    const id = computerOf(req);
    if (!(await opts.describe(id))) throw notYours();
    const { handoff, created } = opts.takeOver(id);
    return reply.code(created ? 201 : 200).send(handoff);
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
    // A person typing a 2FA code is using the computer, so its idle timer must
    // not reap it under them. Their frames above are only watching, and are not.
    const { computerId } = open(req);
    if (computerId) markUsedFor(computerId);
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
