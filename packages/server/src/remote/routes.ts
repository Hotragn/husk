import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { huskError } from '../errors.js';
import { accessTokenOf } from './oauth.js';
import type { Remote } from './oauth.js';

/**
 * Serves one MCP request for a signed-in app: Streamable HTTP, both protocol
 * eras, as `@husk-ai/mcp` builds it (`createRemoteMcp`). Handed in, as the
 * chat tools are, because that package sits above this one.
 */
export type RemoteMcp = (request: Request, who: { owner: string; client: string; name: string }) => Promise<Response>;

/** The request as a web-standard one, for the MCP SDK's fetch-shaped handler. It aborts when the app goes away. */
function webRequest(req: FastifyRequest, url: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host' || v === undefined) continue;
    for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value);
  }
  const body = req.method === 'POST' ? (req.rawBody ?? (typeof req.body === 'string' ? Buffer.from(req.body) : undefined)) : undefined;
  return new Request(url, { method: req.method, headers, signal, ...(body ? { body: new Uint8Array(body) } : {}) });
}

/** `/mcp` under the public URL, the OAuth server around it, and the owner's controls on this machine. */
export async function remoteRoutes(app: FastifyInstance, remote: Remote, mcp: RemoteMcp | undefined): Promise<void> {
  remote.routes(app);

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const token = accessTokenOf(req);
      const claims = token ? await remote.verify(token) : undefined;
      if (!claims) return remote.challenge(reply, Boolean(token));
      if (!mcp) throw huskError('E_NOT_IMPLEMENTED', 'this Husk was started without the chat tools', { hint: 'start it with `husk serve --remote`' });
      const gone = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      const name = remote.store.current.clients[claims.client_id]?.name ?? 'A chat app';
      const res = await mcp(webRequest(req, remote.resource, gone.signal), { owner: claims.sub, client: claims.client_id, name });
      reply.hijack();
      reply.raw.writeHead(res.status, Object.fromEntries(res.headers));
      if (!res.body) {
        reply.raw.end();
        return reply;
      }
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream).pipe(reply.raw);
      return reply;
    },
  });

  // On this machine, with its token: what `husk remote` shows and does.
  app.get('/v1/remote', async () => ({
    on: true,
    publicUrl: remote.origin,
    endpoint: remote.resource,
    owner: Boolean(remote.store.current.owner),
    apps: Object.entries(remote.store.current.clients).map(([id, c]) => ({ id, name: c.name, createdAt: c.createdAt })),
  }));
  app.post('/v1/remote/claim', async () => ({ code: await remote.newClaimCode() }));
  app.post('/v1/remote/reset', async () => {
    await remote.store.reset();
    await remote.store.load();
    return { code: await remote.newClaimCode() };
  });
}
