import type { FastifyInstance } from 'fastify';
import { bearerToken } from '../auth.js';
import { ctxOf } from '../context.js';
import { huskError } from '../errors.js';

/** What a console sign-in code opens: this one route, once. */
export const CONSOLE_SCOPE = 'console';

/**
 * Signing in to the console without the server token in a URL.
 *
 * Whoever holds the token -- `husk console`, `husk serve`, `husk setup`, Husk
 * Bar -- asks for a sign-in code, and the console trades it for the token once.
 * A code that leaks into a terminal's scrollback, a log or browser history is
 * spent or expired by the time anyone finds it: it works once, within ten minutes.
 */
export async function consoleRoutes(app: FastifyInstance, opts: { token?: string | undefined }): Promise<void> {
  const ctx = ctxOf(app);

  // Not under /v1/scoped/, so only the server token reaches it.
  app.post('/v1/console/link', async () => ({ code: ctx.scoped.mint(CONSOLE_SCOPE) }));

  // The one route a sign-in code opens. Minted for this machine only, it is
  // refused under remote access's public URL like any link that is not `public`.
  app.post('/v1/scoped/console', async (req, reply) => {
    const code = bearerToken(req);
    if (req.huskScope !== CONSOLE_SCOPE || !code || !ctx.scoped.take(code, CONSOLE_SCOPE)) {
      throw huskError('E_NO_CREDENTIALS', 'this sign-in link was already used, or has expired', {
        hint: 'run `husk console` on this machine for a new one',
      });
    }
    return reply.header('cache-control', 'no-store').send({ token: opts.token ?? '' });
  });
}
