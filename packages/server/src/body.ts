import type { FastifyInstance } from 'fastify';

/**
 * Raw body capture plus the parsers the API needs.
 *
 * Webhook signatures are computed over the exact bytes received. Re-serialising a
 * parsed object changes key order and whitespace, and then every signature fails
 * for a reason that is invisible in a log.
 */
export function installBodyParsers(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done: (err: Error | null, value?: unknown) => void) => {
      req.rawBody = body;
      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e);
      }
    },
  );

  app.addContentTypeParser(
    ['text/plain', 'application/x-www-form-urlencoded'],
    { parseAs: 'string' },
    (req, body: string, done: (err: Error | null, value?: unknown) => void) => {
      req.rawBody = Buffer.from(body, 'utf8');
      done(null, body);
    },
  );

  // Everything else -- file writes, tarballs, unknown webhook payloads -- stays bytes.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer' },
    (req, body: Buffer, done: (err: Error | null, value?: unknown) => void) => {
      req.rawBody = body;
      done(null, body);
    },
  );
}
