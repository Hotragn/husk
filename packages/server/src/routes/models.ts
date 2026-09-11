import { mapLimit } from '@husk/core';
import type { ChatRequest, ModelInfo, StreamEvent } from '@husk/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../context.js';
import { invalidSpec } from '../errors.js';
import { SseStream, pipeSse } from '../sse.js';

const ContentPartSchema: z.ZodType<unknown> = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), args: z.record(z.unknown()) }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
  z.object({ type: z.literal('thinking'), text: z.string(), signature: z.string().optional() }),
]);

const ChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.union([z.string(), z.array(ContentPartSchema)]),
        name: z.string().optional(),
      }),
    )
    .min(1),
  system: z.string().optional(),
  tools: z
    .array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.unknown()) }))
    .optional(),
  toolChoice: z.union([z.enum(['auto', 'none', 'required']), z.object({ name: z.string() })]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  thinking: z.object({ enabled: z.boolean(), budgetTokens: z.number().int().positive().optional() }).optional(),
  responseFormat: z
    .union([z.object({ type: z.literal('text') }), z.object({ type: z.literal('json'), schema: z.record(z.unknown()).optional() })])
    .optional(),
  metadata: z.record(z.string()).optional(),
});

function parseChat(body: unknown): ChatRequest {
  const parsed = ChatRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw invalidSpec(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return parsed.data as ChatRequest;
}

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);
  const { router, modelProviders, log } = ctx.deps;

  app.get('/v1/models', async () => {
    // Probing every provider in series makes this endpoint as slow as the slowest
    // unreachable one; a dead Ollama should not stall the model picker.
    const probed = await mapLimit(modelProviders, 4, async (p) => {
      let available = false;
      let reason: string | undefined;
      let hint: string | undefined;
      let models: ModelInfo[] = [];
      try {
        const a = await p.isAvailable();
        available = a.available;
        reason = a.reason;
        hint = a.hint;
        if (available) models = await p.listModels();
      } catch (err) {
        reason = (err as Error).message;
      }
      return {
        provider: { id: p.id, displayName: p.displayName, priority: p.priority, available, reason, hint },
        models,
      };
    });

    return {
      models: probed.flatMap((p) => p.models),
      providers: probed.map((p) => p.provider),
    };
  });

  app.post('/v1/models/chat', async (req) => {
    const chat = parseChat(req.body);
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort(new Error('client disconnected')));
    return router.chat({ ...chat, signal: abort.signal });
  });

  app.post('/v1/models/chat/stream', async (req, reply) => {
    const chat = parseChat(req.body);
    const stream = new SseStream(req, reply);
    await pipeSse(stream, (signal): AsyncIterable<StreamEvent> => router.stream({ ...chat, signal }));
    log.debug(`model stream for ${chat.model} closed`);
    return reply;
  });
}
