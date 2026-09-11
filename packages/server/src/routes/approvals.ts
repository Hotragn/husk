import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../context.js';
import { invalidSpec } from '../errors.js';

const AnswerSchema = z
  .object({
    approve: z.boolean(),
    remember: z.boolean().optional().default(false),
  })
  .strict();

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  const ctx = ctxOf(app);

  app.get('/v1/approvals', async () => ({ approvals: ctx.runner.approvals.list() }));

  app.post('/v1/approvals/:approvalId', async (req) => {
    const { approvalId } = req.params as { approvalId: string };
    const parsed = AnswerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidSpec(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
    }
    const pending = ctx.runner.approvals.answer(approvalId, parsed.data.approve, parsed.data.remember);
    ctx.bus.emit('runs', 'approval_answered', { ...pending, approved: parsed.data.approve });
    return { approvalId, approved: parsed.data.approve, remembered: parsed.data.remember && parsed.data.approve };
  });
}
