import { Buffer } from 'node:buffer';
import { HuskError, clampText } from '@husk-ai/core';
import type { Computer, ComputerInfo, ComputerSpec, ExecRequest, ExecResult } from '@husk-ai/core';
import type { ActivityEntry } from '../activity.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../context.js';
import { huskError, invalidSpec, notFound } from '../errors.js';
import { SseStream, closedEarly } from '../sse.js';
import { sendTo } from '../viewers.js';
import { programCall } from './handoffs.js';
import { browseInComputer } from '@husk-ai/core';
import { browserSessionFor, livePageFor } from '@husk-ai/browser';
import type { BrowserSession } from '@husk-ai/browser';
import { localWorkspaceBytes } from '@husk-ai/runtime';

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

/** How often the live screen asks for a frame, at most. */
const SCREEN_FPS = 4;

/** The largest file `fs/read` returns: the same ceiling as an archive. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export async function computerRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  const { manager, log } = ctx.deps;

  app.get('/v1/computers', async () => ({ computers: await manager.list() }));

  // Everything the console's overview needs, in one call: every computer, what
  // each run is doing and which computer it is on, and who is waiting on a person.
  app.get('/v1/overview', async () => {
    const computers = await manager.list();
    // The last tool call on each computer, so a chat's computer shows what it is
    // doing even though no husk run is driving it.
    const activity: Record<string, ActivityEntry> = {};
    for (const c of computers) {
      const last = ctx.activity.latest(c.id);
      if (last) activity[c.id] = last;
    }
    return {
      computers,
      activeRuns: ctx.runner.listActive(),
      handoffs: ctx.runner.handoffs.list(),
      activity,
      // Run by a chat in its own process: watched and taken over from the chat's own link.
      inChat: [...ctx.inChat],
    };
  });

  app.get('/v1/computers/:id/activity', async (req) => {
    const { id } = req.params as { id: string };
    await mustGet(app, id);
    return { entries: ctx.activity.list(id) };
  });

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
    // A chat's computer holds that chat's work, and Husk never removes one on
    // its own. Deleting it takes the id typed back as ?confirm=, which the
    // console sends only after the person confirms.
    const target = await manager.get(id);
    if (target?.info.spec?.labels?.['husk.via'] === 'mcp' && (req.query as { confirm?: unknown }).confirm !== id) {
      throw invalidSpec([`confirm: deleting a chat's computer needs ?confirm=${id}`]);
    }
    const removed = await manager.destroy(id);
    if (!removed) throw notFound('computer', id);
    ctx.bus.emit('computers', 'computer_destroyed', { id });
    return reply.code(204).send();
  });

  // Measured from the host: no exec, so it works on a stopped computer and
  // leaves its last-used time alone. Null where Husk cannot measure it yet.
  app.get('/v1/computers/:id/disk', async (req) => {
    const { id } = req.params as { id: string };
    const { info } = await mustGet(app, id);
    if (info.provider !== 'local') return { bytes: null, note: `not measured for ${info.provider} computers yet` };
    const bytes = await localWorkspaceBytes(info);
    if (bytes !== undefined) return { bytes };
    return { bytes: null, note: info.spec.labels?.['husk.wslWorkspace'] ? 'its workspace is inside WSL' : 'its workspace could not be read' };
  });

  // CPU and memory where the provider can measure them (Docker and Podman, while
  // running), and disk from the host. Every number not measured is null with a
  // note; nothing is estimated.
  app.get('/v1/computers/:id/stats', async (req) => {
    const { id } = req.params as { id: string };
    const computer = await mustGet(app, id);
    const { info } = computer;
    const notes: string[] = [];
    let usage: { cpuPercent?: number; memoryBytes?: number; memoryLimitBytes?: number } = {};
    if (info.state !== 'running') notes.push('CPU and memory are measured only while it runs');
    else if (!computer.usage) notes.push(`CPU and memory are not available for ${info.provider} computers`);
    else {
      try {
        usage = await computer.usage();
      } catch (err) {
        notes.push(`could not read CPU and memory: ${clampText((err as Error).message, 200)}`);
      }
    }
    const diskBytes = info.provider === 'local' ? ((await localWorkspaceBytes(info)) ?? null) : null;
    if (diskBytes === null) notes.push(`disk is not measured for ${info.provider} computers yet`);
    return {
      cpuPercent: usage.cpuPercent ?? null,
      memoryBytes: usage.memoryBytes ?? null,
      memoryLimitBytes: usage.memoryLimitBytes ?? null,
      diskBytes,
      ...(notes.length ? { notes } : {}),
    };
  });

  // A small frame of the computer's browser, only if one is already open.
  // Never launches Chromium: an overview must not start a 111 MB download.
  app.get('/v1/computers/:id/thumbnail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const page = livePageFor(id);
    if (!page) {
      throw huskError('E_BROWSER_NOT_FOUND', 'this computer has no browser open', { hint: 'nothing to show until a run opens a page' });
    }
    const frame = await page.frame(40);
    return reply.header('cache-control', 'no-store').type('image/jpeg').send(Buffer.from(frame.data, 'base64'));
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

  app.post('/v1/computers/:id/exec', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Before any await: a disconnect during the lookup still counts.
    const signal = closedEarly(reply);
    const body = parseOr422(ExecSchema, req.body);
    const computer = await mustGet(app, id);
    const call = programCall(ctx.runner.handoffs, id, req, 'exec', signal);
    try {
      const result: ExecResult = await computer.exec({ ...body, signal: call.signal } as ExecRequest);
      return result;
    } finally {
      call.done();
    }
  });

  app.post('/v1/computers/:id/exec/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr422(ExecSchema, req.body);
    const computer = await mustGet(app, id);
    // Before the stream opens, so a refusal is still an error reply.
    const call = programCall(ctx.runner.handoffs, id, req, 'exec', closedEarly(reply));
    const stream = new SseStream(req, reply);
    try {
      const result = await computer.exec({
        ...body,
        signal: AbortSignal.any([call.signal, stream.signal]),
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
    } finally {
      call.done();
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
    // A person's download: larger than a tool's read, still bounded, since it is held in memory.
    const bytes = await computer.readFile(requirePath(req.query), { maxBytes: MAX_DOWNLOAD_BYTES });
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

  // -- live screen ---------------------------------------------------------

  /**
   * The computer's browser, live, for as long as somebody watches.
   *
   * Frames are pushed: Chrome's own screencast, through the long-lived driver
   * in the computer, acked no faster than SCREEN_FPS and held to this viewer's
   * `fps`. One screencast serves every viewer of a computer and stops when the
   * last one leaves. Where the provider cannot keep a driver running, this asks
   * for one frame at a time instead, as it always did. Watching is not using:
   * only a tool call moves the computer's last-used time, so a screen left open
   * never keeps a computer awake. It never launches a browser: with none open
   * it says so once until one appears.
   */
  app.get('/v1/computers/:id/screen', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    // `?fps=1` for a small screen among many, such as a card on Home. Never above the cap.
    const fps = Math.min(SCREEN_FPS, Math.max(1, Number((req.query as { fps?: string }).fps) || SCREEN_FPS));
    let open = true;
    let stopWatching: (() => void) | undefined;
    socket.on('close', () => {
      open = false;
      stopWatching?.();
      stopWatching = undefined;
    });
    // A frame the viewer is too far behind for is dropped: the next one shows the same screen, newer.
    const send = (obj: unknown, droppable = false) => {
      if (open) sendTo(socket, JSON.stringify(obj), { droppable });
    };
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    void (async () => {
      if (!(await manager.get(id))) {
        send({ type: 'error', code: 'E_COMPUTER_NOT_FOUND', message: `no computer ${id}` });
        socket.close();
        return;
      }
      let idle = false;
      let watched: BrowserSession | undefined;
      let polling = false;
      while (open) {
        const started = Date.now();
        const session = browserSessionFor(id);
        // Asking keeps an open browser from closing for idleness while it is watched.
        const page = session?.livePage();
        if (watched && watched !== session) {
          // Closed and made again: the old session's cast is gone with it.
          stopWatching?.();
          stopWatching = undefined;
          watched = undefined;
          polling = false;
        }
        if (!page || !session) {
          if (!idle) send({ type: 'idle', message: 'no browser is open on this computer yet' });
          idle = true;
          await pause(1000);
          continue;
        }
        idle = false;
        if (!watched) {
          watched = session;
          const stop = await session.watchScreen(
            fps,
            (frame) => send({ type: 'frame', ...frame }, true),
            // Pushing stopped for good after it started: ask for frames instead.
            () => {
              stopWatching = undefined;
              polling = true;
            },
          );
          if (!open) stop?.();
          else if (stop) stopWatching = stop;
          else polling = true;
        }
        if (!polling) {
          await pause(1000);
          continue;
        }
        let wait = 1000 / fps;
        try {
          const frame = await page.frame(60);
          send({ type: 'frame', ...frame }, true);
        } catch {
          // Mid-navigation frames fail and the next one usually lands. A stopped
          // computer fails every time, so slow down rather than spin on it.
          wait = 1000;
        }
        await pause(Math.max(0, wait - (Date.now() - started)));
      }
    })();
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

    // A terminal's output must not go missing: a viewer too far behind is disconnected instead, and reconnects.
    const send = (obj: unknown) => sendTo(socket, JSON.stringify(obj), { droppable: false });

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
