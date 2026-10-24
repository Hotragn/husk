import { audited } from '@husk-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { summarise } from '../activity.js';
import { ctxOf } from '../context.js';
import { huskError, invalidSpec, notFound } from '../errors.js';
import { PERSON_RUN, heldText, takenText } from '../handoffs.js';
import { closedEarly } from '../sse.js';

/** How long a chat's call waits for a person to give back a computer they took. Tests shorten it. */
export const takeover = { waitMs: 45_000 };

function parseBody(body: unknown): { args: Record<string, unknown>; via: string } {
  const b = (body ?? {}) as { args?: unknown; via?: unknown };
  const args = b.args ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw invalidSpec(['args: expected an object']);
  // Who is calling, for the audit log and the timeline: `mcp` for a chat.
  const via = typeof b.via === 'string' && /^[a-z-]{1,32}$/.test(b.via) ? b.via : 'mcp';
  return { args: args as Record<string, unknown>, via };
}

/**
 * `POST /v1/computers/:id/tools/:name` -- run one chat tool on a computer.
 *
 * Every chat's MCP process forwards its computer tools here, so this one
 * long-lived Husk owns each computer's browser session and sees every call:
 * the console can show a chat's live browser and what it is doing, which a
 * browser held inside one chat's own process could never offer. The tools
 * themselves are `@husk-ai/mcp`'s, handed in as `deps.runTool`, so a chat gets
 * the same code here as in its own process.
 */
export async function toolRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);

  app.post('/v1/computers/:id/tools/:name', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, name } = req.params as { id: string; name: string };
    // The chat cancelling its call (MCP notifications/cancelled aborts the request)
    // or going away. Taken before any await, so no disconnect is missed.
    const signal = closedEarly(reply);
    const { args, via } = parseBody(req.body);
    const runTool = ctx.deps.runTool;
    if (!runTool) {
      throw huskError('E_NOT_IMPLEMENTED', 'this server was started without the chat tools', {
        hint: 'start it with `husk serve`, which every chat on this machine uses',
      });
    }
    const found = await ctx.deps.manager.get(id);
    if (!found || found.info.state === 'destroyed') throw notFound('computer', id);

    // A person holds this computer until they say done; the model must not type
    // into the page they are signing in on, or run commands under them.
    const heldNow = () => (name === 'computer_info' ? undefined : ctx.runner.handoffs.list().find((h) => h.computerId === id));
    let held = heldNow();
    // Taken from the console: the call waits a while for the person to give it
    // back, so a short look-in pauses the chat instead of ending its turn.
    const until = Date.now() + takeover.waitMs;
    while (held?.runId === PERSON_RUN && Date.now() < until && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 250));
      held = heldNow();
    }
    if (held) {
      const text = held.runId === PERSON_RUN ? takenText(held.handoffId) : heldText(held.handoffId, held.reason);
      return { isError: true, content: [{ type: 'text', text }] };
    }

    // Cancelled while it waited for the person: nothing runs that nobody asked for any more.
    if (signal.aborted) return { isError: true, content: [{ type: 'text', text: 'the call was cancelled before it ran' }] };

    const started = Date.now();
    const result = await audited(
      { computerId: id, via, tool: name, args },
      () => runTool(found, name, args, signal),
      (r) => (r.isError ? (r.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text : undefined),
    );
    const summary = summarise(name, args);
    const entry = { at: new Date(started).toISOString(), tool: name, ok: !result.isError, ms: Date.now() - started, via, ...(summary ? { summary } : {}) };
    ctx.activity.record(id, entry);
    ctx.bus.emit('computers', 'tool_called', { computerId: id, ...entry });
    return result;
  });
}
