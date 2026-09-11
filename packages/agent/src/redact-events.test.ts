import { describe, expect, it } from 'vitest';
import { redactEvent } from './redact-events.js';
import type { AgentRunEvent } from './types.js';

/**
 * Run events do not only reach the model. They reach the CLI's terminal, every
 * SSE client, the console, and the run log on disk. A credential that survives
 * any of those has leaked, so redaction is asserted per channel rather than
 * once on the model-facing path.
 */

const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const AWS = 'AKIAIOSFODNN7EXAMPLE';

function textOf(e: AgentRunEvent): string {
  return JSON.stringify(e);
}

describe('redactEvent', () => {
  it('scrubs streamed stdout, the channel that reaches a human terminal', () => {
    const out = redactEvent({
      type: 'tool_delta',
      callId: 'c1',
      tool: 'shell',
      stream: 'stdout',
      text: `ANTHROPIC_API_KEY=${KEY}`,
    } as AgentRunEvent);
    expect(textOf(out)).not.toContain(KEY);
    expect(textOf(out)).toContain('redacted');
  });

  it('scrubs streamed stderr too', () => {
    const out = redactEvent({
      type: 'tool_delta',
      callId: 'c1',
      tool: 'shell',
      stream: 'stderr',
      text: `failed with ${AWS}`,
    } as AgentRunEvent);
    expect(textOf(out)).not.toContain(AWS);
  });

  it('scrubs the completed tool output that lands in the run log', () => {
    const out = redactEvent({
      type: 'tool_end',
      call: { type: 'tool_call', id: 'c1', name: 'shell', args: {} },
      output: `token=${KEY}`,
      isError: false,
      durationMs: 5,
    } as AgentRunEvent);
    expect(textOf(out)).not.toContain(KEY);
  });

  it('scrubs a credential passed on the command line', () => {
    const out = redactEvent({
      type: 'tool_start',
      call: { type: 'tool_call', id: 'c1', name: 'shell', args: { command: `curl -H "auth: ${KEY}" x` } },
    } as AgentRunEvent);
    expect(textOf(out)).not.toContain(KEY);
  });

  it('scrubs error and warning text', () => {
    expect(textOf(redactEvent({ type: 'error', error: { message: KEY } } as AgentRunEvent))).not.toContain(KEY);
    expect(textOf(redactEvent({ type: 'warning', message: KEY } as AgentRunEvent))).not.toContain(KEY);
  });

  it('leaves structure and identifiers intact so events stay correlatable', () => {
    const out = redactEvent({
      type: 'tool_delta',
      callId: 'call_abc',
      tool: 'shell',
      stream: 'stdout',
      text: 'nothing secret here',
    } as AgentRunEvent) as Extract<AgentRunEvent, { type: 'tool_delta' }>;
    expect(out.callId).toBe('call_abc');
    expect(out.tool).toBe('shell');
    expect(out.stream).toBe('stdout');
    expect(out.text).toBe('nothing secret here');
  });

  it('does not touch the model token stream', () => {
    // Mangling this mid-stream would corrupt the text a caller is rendering.
    // The defence for the model is not being handed the secret in the first
    // place, which tool-result redaction already covers.
    const e = { type: 'text_delta', text: 'here is a sentence' } as AgentRunEvent;
    expect(redactEvent(e)).toEqual(e);
  });

  it('passes non-string tool arguments through unchanged', () => {
    const out = redactEvent({
      type: 'tool_start',
      call: { type: 'tool_call', id: 'c1', name: 'shell', args: { timeoutSec: 30, quiet: true } },
    } as AgentRunEvent) as Extract<AgentRunEvent, { type: 'tool_start' }>;
    expect(out.call.args).toEqual({ timeoutSec: 30, quiet: true });
  });
});
