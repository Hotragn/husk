import { Buffer } from 'node:buffer';
import { HuskError, clampText } from '@husk/core';
import type { Computer, ComputerInfo, ComputerSpec, ExecRequest, ExecResult } from '@husk/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../context.js';
import { huskError, invalidSpec, notFound } from '../errors.js';
import { SseStream } from '../sse.js';
import { browseInComputer } from '@husk/core';

const NetworkPolicySchema = z.object({
  mode: z.enum(['none', 'egress', 'full']),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

/**
 * `ComputerSpec` is an interface in core, not a schema, so the wire form is
 * validated here. Unknown keys are rejected: a typo'd `memoryMB` that silently
 * became "no memory limit" is exactly the kind of quiet failure that costs an hour.
 */
const ComputerSpecSchema = z
  .object({
    name: z.string().min(1).max(96).optional(),
    provider: z.string().min(1).optional(),
    image: z.string().min(1).optional(),
    flavor: z.enum(['base', 'python', 'node', 'full']).optional(),
    cpus: z.number().positive().max(64).optional(),
    memoryMb: z.number().int().positive().max(131_072).optional(),
    diskMb: z.number().int().positive().optional(),
    idleTimeoutSec: z.number().int().min(0).optional(),
    maxLifetimeSec: z.number().int().min(0).optional(),
    network: NetworkPolicySchema.optional(),
    env: z.record(z.string()).optional(),
    mounts: z
      .array(z.object({ source: z.string(), target: z.string(), readonly: z.boolean().optional() }))
      .optional(),
    workdir: z.string().optional(),
    user: z.string().optional(),
    persist: z.boolean().optional(),
    packages: z.array(z.string()).optional(),
    setup: z.string().optional(),
    labels: z.record(z.string()).optional(),
  })
  .strict();

const ExecSchema = z
  .object({
    cmd: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    timeoutSec: z.number().int().positive().max(3600).optional(),
    stdin: z.string().optional(),
    tty: z.boolean().optional(),
    user: z.string().optional(),
    maxOutputBytes: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  })
  .strict();

function parseOr422<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw invalidSpec(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return parsed.data;
}

async function mustGet(app: FastifyInstance, id: string): Promise<Computer> {
  const computer = await ctxOf(app).deps.manager.get(id);
  if (!computer) throw notFound('computer', id);
  return computer;
}

function requirePath(query: unknown): string {
  const p = (query as { path?: unknown })?.path;
  if (typeof p !== 'string' || p.length === 0) {
    throw huskError('E_SPEC_INVALID', 'missing required query parameter `path`', {
      hint: 'e.g. /v1/computers/:id/fs?path=/work',
    });
  }
  return p;
}

export async function computerRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  const { manager, log } = ctx.deps;

  app.get('/v1/computers', async () => ({ computers: await manager.list() }));

  app.post('/v1/computers', async (req: FastifyRequest, reply: FastifyReply) => {
    const spec = parseOr422(ComputerSpecSchema, req.body) as ComputerSpec;
    const computer = await manager.create(spec);
    const info = computer.info;
    ctx.bus.emit('computers', 'computer_created', info);
    return reply.code(201).send(info);
  });

  app.get('/v1/computers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const computer = await mustGet(app, id);
    return computer.refresh();
  });

  app.delete('/v1/computers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = await manager.destroy(id);
    if (!removed) throw notFound('computer', id);
    ctx.bus.emit('computers', 'computer_destroyed', { id });
    return reply.code(204).send();
  });

  app.post('/v1/computers/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    const computer = await mustGet(app, id);
    await computer.stop();
    const info: ComputerInfo = await computer.refresh();
    ctx.bus.emit('computers', 'computer_stopped', info);
    return info;
  });

  app.post('/v1/computers/:id/start', async (req) => {
    const { id } = req.params as { id: string };
    const computer = await mustGet(app, id);
    await computer.start();
    const info: ComputerInfo = await computer.refresh();
    ctx.bus.emit('computers', 'computer_started', info);
    return info;
  });

  app.post('/v1/computers/:id/exec', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseOr422(ExecSchema, req.body);
    const computer = await mustGet(app, id);
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort(new HuskError('E_ABORTED', 'client disconnected')));
    const result: ExecResult = await computer.exec({ ...body, signal: abort.signal } as ExecRequest);
    return result;
  });

  app.post('/v1/computers/:id/exec/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr422(ExecSchema, req.body);
    const computer = await mustGet(app, id);
    const stream = new SseStream(req, reply);
    try {
      const result = await computer.exec({
        ...body,
        signal: stream.signal,
        onStdout: (data) => stream.send({ type: 'stdout', data }),
        onStderr: (data) => stream.send({ type: 'stderr', data }),
      } as ExecRequest);
      stream.send({ type: 'exit', result });
      stream.done();
    } catch (err) {
      if (!stream.signal.aborted) {
        stream.sendError(err);
        stream.done();
      } else {
        stream.close();
      }
    }
    return reply;
  });

  // -- files ---------------------------------------------------------------

  app.get('/v1/computers/:id/fs', async (req) => {
    const { id } = req.params as { id: string };
    const computer = await mustGet(app, id);
    return { entries: await computer.listDir(requirePath(req.query)) };
  });

  app.get('/v1/computers/:id/fs/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    const computer = await mustGet(app, id);
    const bytes = await computer.readFile(requirePath(req.query));
    return reply.type('application/octet-stream').send(Buffer.from(bytes));
  });

  app.put('/v1/computers/:id/fs/write', async (req, reply) => {
    const { id } = req.params as { id: string };
    const computer = await mustGet(app, id);
    const body = req.body;
    const content =
      body instanceof Buffer ? new Uint8Array(body) : typeof body === 'string' ? body : Buffer.from(String(body ?? ''));
    await computer.writeFile(requirePath(req.query), content);
    return reply.code(204).send();
  });

  app.delete('/v1/computers/:id/fs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const computer = await mustGet(app, id);
    const recursive = (req.query as { recursive?: string }).recursive === 'true';
    await computer.remove(requirePath(req.query), { recursive });
    return reply.code(204).send();
  });

  app.post('/v1/computers/:id/ports', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseOr422(z.object({ port: z.number().int().min(1).max(65535) }).strict(), req.body);
    const computer = await mustGet(app, id);
    const binding = await computer.exposePort(body.port);
    ctx.bus.emit('computers', 'port_exposed', { id, port: body.port, binding });
    return binding;
  });

  // -- browser -------------------------------------------------------------

  /**
   * Load a page from inside the computer.
   *
   * Deliberately not a host `fetch()`. The console's browser has to show the
   * page the *agent* would get -- same IP, same DNS, same egress -- or the two
   * are looking at different machines. It is also the one place the declared
   * `network` policy becomes real on the `local` provider, which cannot filter
   * egress at the OS level.
   */
  app.post('/v1/computers/:id/browse', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseOr422(
      z
        .object({
          url: z.string().min(1),
          follow: z.boolean().optional(),
          timeoutSec: z.number().int().min(1).max(120).optional(),
          maxBytes: z.number().int().min(1024).max(4_000_000).optional(),
        })
        .strict(),
      req.body,
    );
    const computer = await mustGet(app, id);
    const page = await browseInComputer(computer, body);
    ctx.bus.emit('computers', 'browsed', { id, url: page.url, status: page.status });
    return page;
  });

  // -- terminal ------------------------------------------------------------

  /**
   * A pty over a socket without a native pty module.
   *
   * `exec` with `tty: true` is as close as the providers get, so the socket carries
   * one command per session rather than a persistent shell. That is a real
   * limitation and it is stated here rather than faked with a half-working REPL.
   */
  app.get('/v1/computers/:id/terminal', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const abort = new AbortController();
    let closed = false;

    const send = (obj: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    socket.on('close', () => {
      closed = true;
      abort.abort(new HuskError('E_ABORTED', 'terminal socket closed'));
    });

    let computer: Computer | undefined;
    /**
     * Looking the computer up is async, and a programmatic client sends as soon
     * as the socket opens. The listener therefore has to be attached now and the
     * frames held until the machine resolves -- registering it after the await
     * silently drops whatever arrived first, which a human typist never notices
     * and every script hits immediately.
     */
    const backlog: string[] = [];

    const runCommand = (cmd: string) => {
      if (!computer || closed) return;
      void computer
        .exec({
          cmd,
          tty: true,
          signal: abort.signal,
          onStdout: (data) => send({ type: 'stdout', data }),
          onStderr: (data) => send({ type: 'stderr', data }),
        })
        .then((result) => send({ type: 'exit', exitCode: result.exitCode, durationMs: result.durationMs }))
        .catch((err: unknown) => send({ type: 'error', error: clampText((err as Error).message, 4096).text }));
    };

    const handle = (text: string) => {
      let control: { type?: string; cols?: number; rows?: number; cmd?: string } | undefined;
      try {
        control = JSON.parse(text) as typeof control;
      } catch {
        control = undefined;
      }
      if (control?.type === 'resize') {
        // Recorded rather than applied: without a pty there is nothing to resize.
        log.debug(`terminal resize ${control.cols}x${control.rows}`);
        return;
      }
      const cmd = control?.type === 'exec' && control.cmd ? control.cmd : text;
      if (!cmd.trim() || closed) return;
      if (!computer) {
        backlog.push(cmd);
        return;
      }
      runCommand(cmd);
    };

    socket.on('message', (raw: unknown) => {
      handle(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    });

    void (async () => {
      try {
        computer = await mustGet(app, id);
      } catch (err) {
        send({ type: 'error', error: (err as Error).message });
        socket.close(1011, 'computer not found');
        return;
      }
      if (closed) return;
      send({ type: 'ready', computerId: computer.id, workdir: computer.info.workdir });
      // The socket is serial, so the backlog drains in the order it arrived.
      for (const cmd of backlog.splice(0)) runCommand(cmd);
    })();
  });
}
