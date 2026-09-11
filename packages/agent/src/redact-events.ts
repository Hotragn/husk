import { redact } from '@husk/core';
import type { AgentRunEvent } from './types.js';

/**
 * Strip credential-shaped strings from anything a run emits.
 *
 * Applied at the single emit chokepoint in the loop, because run events do not
 * only reach the model -- they reach the CLI's terminal output, every SSE
 * client, the console, and `~/.husk/runs/**\/events.ndjson` on disk. An
 * `AWS_SECRET_ACCESS_KEY` echoed by a stray `env` should not survive in any of
 * those, and the model-facing `tool_result` is the one place that was already
 * covered.
 *
 * Only free text is touched. Ids, tool names, numbers and structure are left
 * alone so a consumer can still correlate events.
 */
export function redactEvent(event: AgentRunEvent): AgentRunEvent {
  switch (event.type) {
    case 'tool_delta':
      return { ...event, text: redact(event.text) };

    case 'tool_end':
      return { ...event, output: redact(event.output) };

    case 'tool_denied':
      return { ...event, reason: redact(event.reason) };

    case 'tool_start':
      return { ...event, call: { ...event.call, args: redactArgs(event.call.args) } };

    case 'warning':
      return { ...event, message: redact(event.message) };

    case 'error':
      return { ...event, error: { ...event.error, message: redact(event.error.message) } };

    // The model's own tokens are not redacted. A model that repeats a secret
    // back has already been given it, and mangling its output mid-stream would
    // corrupt the text the caller is rendering. The fix for that is not letting
    // the secret reach the model, which is what tool-result redaction does.
    default:
      return event;
  }
}

/** Tool arguments are attacker-influenced free text -- a command line can carry a token. */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' ? redact(v) : v;
  }
  return out;
}
