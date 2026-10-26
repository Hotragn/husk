import { PassThrough } from 'node:stream';
import { audited } from '@husk-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { summarise } from '../activity.js';
import { ctxOf } from '../context.js';
import { errorBody, huskError, invalidSpec, notFound } from '../errors.js';
import { PERSON_RUN, refusalText } from '../handoffs.js';
import { closedEarly } from '../sse.js';
import { givenBack, underControl } from '../control.js';

/** How long a chat's call waits for a person to give back a computer they took. Tests shorten it. */
export const takeover = { waitMs: 45_000 };

/** How often a long call's answer says it is still coming. Tests shorten it. */
export const keepAlive = { ms: 20_000 };

/**
 * A call's answer, as usual unless the call outlasts `keepAlive.ms`: then a 200
 * goes out at once, a space every `keepAlive.ms` after it, and the JSON last.
 * A chat's fetch gives up on headers that take 300 s, or a body quiet that
 * long, and a call can outlast both: an hour-long command, or a bot waiting
 * for its computer back. JSON allows the leading spaces, so the answer reads
 * the same; an error that comes after the 200 is in the body.
 */
async function keptAlive(reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> {
  let body: PassThrough | undefined;
  const beat = setInterval(() => {
    if (!body) void reply.type('application/json').send((body = new PassThrough()));
    body.write(' ');
  }, keepAlive.ms);
  try {
    const result = await work();
    if (!body) return result;
    body.end(JSON.stringify(result));
  } catch (err) {
    if (!body) throw err;
    body.end(JSON.stringify(errorBody(err)));
  } finally {
    clearInterval(beat);
  }
  return reply;
}

function parseBody(body: unknown): { args: Record<string, unknown>; via: string } {
  const b = (body ?? {}) as { args?: unknown; via?: unknown };
  const args = b.args ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw invalidSpec(['args: expected an object']);
  // Who is calling, for the audit log and the timeline: `mcp` for a chat, `bot` for a bot on a person's own CLI.
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

    return keptAlive(reply, async () => {
      // A person holds this computer until they say done; the model must not type
      // into the page they are signing in on, or run commands under them.
      const heldNow = () => (name === 'computer_info' ? undefined : ctx.runner.handoffs.list().find((h) => h.computerId === id));
      let held = heldNow();
      // Taken from the console: the call waits a while for the person to give it
      // back, so a short look-in pauses the chat instead of ending its turn. A
      // bot's call (via `bot`, J5-e) waits until they do: nobody is there to tell.
      if (held?.runId === PERSON_RUN) {
        await givenBack(ctx.runner.handoffs, id, signal, via === 'bot' ? Infinity : Date.now() + takeover.waitMs);
        held = heldNow();
      }
      if (held) {
        return { isError: true, content: [{ type: 'text', text: refusalText(held) }] };
      }

      // Cancelled while it waited for the person: nothing runs that nobody asked for any more.
      if (signal.aborted) return { isError: true, content: [{ type: 'text', text: 'the call was cancelled before it ran' }] };

      const started = Date.now();
      // As it starts, not as it ends: the desktop app opens the computer's window on this.
      ctx.bus.emit('computers', 'tool_started', { computerId: id, tool: name, via, at: new Date(started).toISOString() });
      // A take-over stops it part-way, and a stale page action is refused (handoffs.ts).
      const result = await underControl(ctx.runner.handoffs, id, name, signal, (stop) =>
        audited(
          { computerId: id, via, tool: name, args },
          () => runTool(found, name, args, stop),
          (r) => (r.isError ? (r.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text : undefined),
        ),
      );
      const summary = summarise(name, args);
      const entry = { at: new Date(started).toISOString(), tool: name, ok: !result.isError, ms: Date.now() - started, via, ...(summary ? { summary } : {}) };
      ctx.activity.record(id, entry);
      ctx.bus.emit('computers', 'tool_called', { computerId: id, ...entry });
      return result;
    });
  });
}
