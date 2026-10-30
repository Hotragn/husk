import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WorkspaceStore, WorkspaceError } from '@husk-ai/workspaces';
import { z } from 'zod';

const nameBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const sourceBody = z.object({ url: z.string().min(1).max(4096) }).strict();
const fileBody = z.object({ path: z.string().min(1), content: z.string(), sourceIds: z.array(z.string()).optional() }).strict();
const fileQuery = z.object({ path: z.string().min(1) }).strict();
const deleteBody = z.object({ confirmName: z.string().min(1) }).strict();

/** The same workspace API serves the MCP companion and the full control plane. */
export async function registerWorkspaceRoutes(app: FastifyInstance, store = new WorkspaceStore()): Promise<void> {
  await app.register(async (routes) => {
    routes.setErrorHandler((error, _req, reply) => {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: { code: 'E_INPUT', message: error.issues.map((i) => i.message).join('; ') } });
      }
      if (error instanceof WorkspaceError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      return reply.code(500).send({ error: { code: 'E_WORKSPACE', message: 'The workspace could not be updated. Retry or check the local Husk logs.' } });
    });
    routes.get('/v1/workspaces', async () => ({ workspaces: await store.list() }));
    routes.post('/v1/workspaces', async (req, reply) => reply.code(201).send(await store.create(nameBody.parse(req.body).name)));
    routes.get<{ Params: { id: string } }>('/v1/workspaces/:id', async (req) => store.get(req.params.id));
    routes.post<{ Params: { id: string } }>('/v1/workspaces/:id/sources', async (req) => store.addSource(req.params.id, sourceBody.parse(req.body).url));
    routes.get<{ Params: { id: string } }>('/v1/workspaces/:id/files', async (req) => store.read(req.params.id, fileQuery.parse(req.query).path));
    routes.put<{ Params: { id: string } }>('/v1/workspaces/:id/files', async (req) => {
      const body = fileBody.parse(req.body);
      return store.write(req.params.id, body.path, body.content, body.sourceIds);
    });
    routes.get<{ Params: { id: string } }>('/v1/workspaces/:id/download', async (req, reply) => {
      const file = await store.read(req.params.id, fileQuery.parse(req.query).path);
      return reply.type('application/octet-stream').header('Content-Disposition', attachment(basename(file.path))).send(Buffer.from(file.content, 'utf8'));
    });
    routes.get<{ Params: { id: string } }>('/v1/workspaces/:id/export', async (req, reply) => {
      const workspace = await store.get(req.params.id);
      const zip = await store.export(workspace.id);
      return reply.type('application/zip').header('Content-Disposition', attachment(`${workspace.name}.zip`)).send(zip);
    });
    routes.delete<{ Params: { id: string } }>('/v1/workspaces/:id', async (req) => {
      await store.remove(req.params.id, deleteBody.parse(req.body).confirmName);
      return { ok: true };
    });
  });
}

function attachment(name: string): string {
  return `attachment; filename="${name.replace(/[^a-zA-Z0-9._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`;
}
