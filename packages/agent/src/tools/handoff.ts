import { HuskError } from '@husk-ai/core';
import { defineTool } from '../types.js';
import type { AgentTool } from '../types.js';
import { object, str } from './util.js';

/** Long enough for a sentence a person can act on, short enough to read in a banner. */
const MAX_REASON = 500;

/**
 * Stop and wait for a person.
 *
 * Opt-in: a husk gets this only when it names `hand_off` itself, because a
 * model that can pause its own run is a choice the husk author should make.
 * It is not `dangerous` -- pausing does nothing to the machine -- so it never
 * raises an approval on top of the handoff.
 */
export const hand_off = defineTool<{ reason: string }, string>({
  name: 'hand_off',
  optIn: true,
  description:
    'Pause and wait for a person to do something only they can do: sign in, enter a 2FA or TOTP code, or approve a prompt. ' +
    'The run waits until they say they are done. Give one sentence they can act on, such as "Sign in to example.com and approve the prompt." ' +
    'Do not use this to ask a question you can answer yourself.',
  parameters: object(
    {
      reason: str('One sentence telling the person what to do.', { maxLength: MAX_REASON }),
    },
    ['reason'],
  ),
  async handler({ reason }, ctx) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text) throw new HuskError('E_TOOL_ERROR', 'hand_off needs a reason the person can read');
    if (text.length > MAX_REASON) {
      throw new HuskError('E_TOOL_ERROR', `hand_off reason is over ${MAX_REASON} characters`);
    }
    if (!ctx.handoff) {
      throw new HuskError('E_TOOL_ERROR', 'nobody is connected to take over this run');
    }
    const outcome = await ctx.handoff({ runId: ctx.runId, huskId: ctx.huskId, reason: text });
    if (outcome !== 'done') {
      throw new HuskError('E_ABORTED', 'the run ended before the person finished');
    }
    return 'The person says they are done. The page may have changed while they had it, so look again before you act.';
  },
});

export const handoffTools: AgentTool[] = [hand_off as unknown as AgentTool];
