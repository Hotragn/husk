import type { FastifyInstance } from 'fastify';
import { ctxOf } from '../context.js';
import type { EventTopic, HuskEvent } from '../events.js';

const TOPICS: EventTopic[] = ['computers', 'runs', 'providers', 'triggers', 'adapters', 'reaper'];

function parseTopics(value: unknown): EventTopic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const picked = value.filter((v): v is EventTopic => typeof v === 'string' && (TOPICS as string[]).includes(v));
  return picked.length ? picked : undefined;
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);

  app.get('/v1/events', { websocket: true }, (socket) => {
    let topics: Set<EventTopic> | undefined;

    const write = (event: HuskEvent) => {
      if (topics && !topics.has(event.topic)) return;
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ type: event.type, at: event.at, topic: event.topic, payload: event.payload }));
    };

    const unsubscribe = ctx.bus.subscribe(write);
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);

    socket.on('message', (raw: unknown) => {
      let msg: { type?: string; topics?: unknown } | undefined;
      try {
        msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg?.type === 'subscribe') {
        const picked = parseTopics(msg.topics);
        topics = picked ? new Set(picked) : undefined;
        socket.send(JSON.stringify({ type: 'subscribed', at: new Date().toISOString(), topics: picked ?? TOPICS }));
        // Replay what the console missed, filtered the same way as live traffic.
        for (const past of ctx.bus.history(picked)) write(past);
      }
      if (msg?.type === 'ping') socket.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
    });

    socket.send(
      JSON.stringify({
        type: 'hello',
        at: new Date().toISOString(),
        topic: 'providers',
        payload: { topics: TOPICS, activeRuns: ctx.runner.listActive() },
      }),
    );
  });
}
