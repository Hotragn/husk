import { audited } from '@husk-ai/core';
import { ctxOf, invalidSpec, notFound, summarise } from '@husk-ai/server';
import type { CreateAppOptions } from '@husk-ai/server';
import { ensureRunning } from '@husk-ai/runtime';
import { callTool } from './tools.js';

/** The Fastify instance, named through the server's own plugin type so this package needs no Fastify import. */
type App = Parameters<NonNullable<CreateAppOptions['plugins']>[number]>[0];

function parseBody(body: unknown): { args: Record<string, unknown>; via: string } {
  const b = (body ?? {}) as { args?: unknown; via?: unknown };
  const args = b.args ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw invalidSpec(['args: expected an object']);
  // Who is calling, for the audit log and the timeline: `mcp` for a chat.
  const via = typeof b.via === 'string' && /^[a-z-]{1,32}$/.test(b.via) ? b.via : 'mcp';
  return { args: args as Record<string, unknown>, via };
}

/**
 * `POST /v1/computers/:id/tools/:name` -- run one computer tool in this process.
 *
 * Registered into `husk serve` as a plugin. Every chat's MCP process forwards
 * its computer tools here, so the one long-lived Husk owns each computer's
 * browser session and sees every call: the console can show a chat's live
 * browser and what it is doing, which a browser held inside one chat's own
 * process could never offer. The tool code is the same `callTool` the MCP
 * process would have run itself.
 */
export async function toolRoutes(app: App): Promise<void> {
  const ctx = ctxOf(app);

  app.post('/v1/computers/:id/tools/:name', async (req) => {
    const { id, name } = req.params as { id: string; name: string };
    const { args, via } = parseBody(req.body);
    const found = await ctx.deps.manager.get(id);
    if (!found || found.info.state === 'destroyed') throw notFound('computer', id);
    const computer = await ensureRunning(found);

    const started = Date.now();
    const result = await audited(
      { computerId: id, via, tool: name, args },
      () => callTool(computer, name, args),
      (r) => (r.isError ? (r.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text : undefined),
    );
    const entry = {
      at: new Date(started).toISOString(),
      tool: name,
      ok: !result.isError,
      ms: Date.now() - started,
      via,
      ...(summarise(name, args) ? { summary: summarise(name, args) } : {}),
    };
    ctx.activity.record(id, entry);
    ctx.bus.emit('computers', 'tool_called', { computerId: id, ...entry });
    return result;
  });
}
