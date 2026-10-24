import { audited } from '@husk-ai/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { summarise } from '../activity.js';
import { ctxOf } from '../context.js';
import { huskError, invalidSpec, notFound } from '../errors.js';
import { heldText } from '../handoffs.js';

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

  app.post('/v1/computers/:id/tools/:name', async (req: FastifyRequest) => {
    const { id, name } = req.params as { id: string; name: string };
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
    const held = ctx.runner.handoffs.list().find((h) => h.computerId === id);
    if (held && name !== 'computer_info') return { isError: true, content: [{ type: 'text', text: heldText(held.handoffId, held.reason) }] };

    const started = Date.now();
    const result = await audited(
      { computerId: id, via, tool: name, args },
      () => runTool(found, name, args),
      (r) => (r.isError ? (r.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text : undefined),
    );
    const summary = summarise(name, args);
    const entry = { at: new Date(started).toISOString(), tool: name, ok: !result.isError, ms: Date.now() - started, via, ...(summary ? { summary } : {}) };
    ctx.activity.record(id, entry);
    ctx.bus.emit('computers', 'tool_called', { computerId: id, ...entry });
    return result;
  });
}
