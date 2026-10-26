import { connectChatApp, detectChatApps, disconnectChatApp, followDesktopApp, huskLaunch, sameLaunch } from '@husk-ai/core';
import type { ChatAppId } from '@husk-ai/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../context.js';
import { huskError, invalidSpec } from '../errors.js';

const Choice = z
  .object({
    provider: z.string().regex(/^[a-z]{2,16}$/).optional(),
    flavor: z.enum(['base', 'python', 'node', 'full']).optional(),
  })
  .strict();

function parseChoice(body: unknown): z.infer<typeof Choice> {
  const parsed = Choice.safeParse(body ?? {});
  if (!parsed.success) throw invalidSpec(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  return parsed.data;
}

/**
 * The console's Connect page: which chat apps are here and use Husk, which
 * computers this machine can run, and a quick test of one. The same code as
 * `husk setup`, behind the server token like every other route that changes
 * something on this machine.
 */
export async function setupRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  // Whose apps: the real user's, or a test's own folder.
  const home = ctx.deps.chatAppsHome;
  const apps = () => detectChatApps(home);
  const known = (id: string): ChatAppId => {
    if (!apps().some((a) => a.id === id)) throw huskError('E_ROUTE_NOT_FOUND', `Husk does not know a chat app called ${id}`);
    return id as ChatAppId;
  };

  // A browser sends a cross-site POST with a plain text body without asking
  // first. Requiring JSON makes it ask (a CORS preflight), which this server
  // refuses, so another website cannot connect Husk to your apps.
  app.addHook('onRequest', async (req) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/setup')) return;
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw huskError('E_SPEC_INVALID', 'setup requests must be JSON', { hint: 'send Content-Type: application/json' });
    }
  });

  app.get('/v1/setup', async () => ({
    apps: apps(),
    computers: await ctx.deps.manager.status(),
  }));

  app.post('/v1/setup/apps/:app', async (req: FastifyRequest) => {
    const { app: id } = req.params as { app: string };
    return connectChatApp(known(id), huskLaunch(parseChoice(req.body)), home ? { home } : {});
  });

  // The desktop app, once it updated or moved: chat apps that start an older
  // copy of it start this one, keeping their own flags. Only while this Husk
  // runs that app's own launch line, which the app sends to compare. Husk
  // writes its own line, never one from a request.
  app.post('/v1/setup/follow', async (req: FastifyRequest) => {
    const ours = huskLaunch();
    if (!sameLaunch(ours, (req.body as { launch?: unknown } | null)?.launch)) return { moved: [] };
    return { moved: await followDesktopApp(ours, home ? { home } : {}) };
  });

  app.delete('/v1/setup/apps/:app', async (req: FastifyRequest) => {
    const { app: id } = req.params as { app: string };
    return disconnectChatApp(known(id), home ? { home } : {});
  });

  // Make a throwaway computer, run one command in it, and remove it again.
  app.post('/v1/setup/test', async (req: FastifyRequest) => {
    const choice = parseChoice(req.body);
    const started = Date.now();
    const computer = await ctx.deps.manager.create({
      name: `husk-test-${process.pid}-${started}`,
      ...(choice.provider && choice.provider !== 'auto' ? { provider: choice.provider } : {}),
      ...(choice.flavor ? { flavor: choice.flavor } : {}),
    });
    try {
      const r = await computer.exec({ cmd: 'uname -sr || ver', timeoutSec: 60 });
      return { ok: r.exitCode === 0, provider: computer.info.provider, output: r.stdout.trim().slice(0, 500), ms: Date.now() - started };
    } finally {
      await ctx.deps.manager.destroy(computer.id).catch(() => undefined);
    }
  });
}
