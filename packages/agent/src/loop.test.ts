import { createLogger } from '@husk-ai/core';
import type { ModelMessage, ToolCallPart, ToolResultPart } from '@husk-ai/core';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from './loop.js';
import {
  FakeComputerSource,
  FakeRouter,
  abortableDelay,
  specFor,
  toolCall,
  type ScriptedTurn,
} from './test-support.js';
import {
  defineTool,
  type AgentRunEvent,
  type AgentRunOptions,
  type AgentTool,
  type ApprovalRequest,
} from './types.js';

const silent = createLogger({ level: 'silent' });

function echo(name: string, opts: { dangerous?: boolean; delayMs?: number } = {}): AgentTool {
  return defineTool<{ value?: string }, string>({
    name,
    description: `echo ${name}`,
    dangerous: opts.dangerous,
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    async handler(input, ctx) {
      if (opts.delayMs) await abortableDelay(opts.delayMs, ctx.signal);
      return `${name}:${input.value ?? ''}`;
    },
  });
}

function agentWith(turns: ScriptedTurn[], tools: AgentTool[], patch: Parameters<typeof specFor>[0] = {}) {
  const router = new FakeRouter(turns);
  const agent = new Agent({
    spec: specFor({ persona: 'be useful', ...patch }),
    router,
    tools: tools as never,
    logger: silent,
  });
  return { agent, router };
}

async function collect(agent: Agent, opts: AgentRunOptions): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const e of agent.stream(opts)) events.push(e);
  return events;
}

function toolResults(messages: ModelMessage[]): ToolResultPart[] {
  return messages
    .filter((m) => m.role === 'tool')
    .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
    .filter((p): p is ToolResultPart => p.type === 'tool_result');
}

describe('Agent: assistant message shape', () => {
  it('keeps text and tool calls together in one assistant message', async () => {
    const call = toolCall('c1', 'echo', { value: 'hi' });
    const { agent, router } = agentWith(
      [
        { text: 'Let me check that for you.', toolCalls: [call] },
        { text: 'All done.' },
      ],
      [echo('echo')],
    );

    const result = await agent.run({ input: 'go' });

    const assistant = result.messages.find((m) => m.role === 'assistant')!;
    expect(Array.isArray(assistant.content)).toBe(true);
    const parts = assistant.content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool_call']);
    expect(parts[1]).toMatchObject({ type: 'tool_call', id: 'c1', name: 'echo' });

    // ...and the model sees both on the next call, which is the actual bug.
    const second = router.requests[1]!;
    const roundTripped = second.messages.find((m) => m.role === 'assistant')!;
    expect(roundTripped.content).toEqual([
      { type: 'text', text: 'Let me check that for you.' },
      { type: 'tool_call', id: 'c1', name: 'echo', args: { value: 'hi' } },
    ]);
    expect(result.text).toBe('All done.');
    expect(result.stopReason).toBe('complete');
  });

  it('returns tool output as a tool message keyed by toolCallId', async () => {
    const call = toolCall('c9', 'echo', { value: 'x' });
    const { agent } = agentWith([{ toolCalls: [call] }, { text: 'ok' }], [echo('echo')]);
    const result = await agent.run({ input: 'go' });
    expect(toolResults(result.messages)).toEqual([
      { type: 'tool_result', toolCallId: 'c9', content: 'echo:x', isError: false },
    ]);
  });

  it('preserves thinking alongside text and calls', async () => {
    const { agent } = agentWith([{ thinking: 'hmm', text: 'sure', toolCalls: [toolCall('c1', 'echo')] }, { text: '' }], [
      echo('echo'),
    ]);
    const result = await agent.run({ input: 'go' });
    const parts = result.messages.find((m) => m.role === 'assistant')!.content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_call']);
  });
});

describe('Agent: streaming', () => {
  it('forwards text and thinking deltas as they arrive', async () => {
    const { agent } = agentWith([{ thinking: 'weighing options', text: 'Hello there, world.' }], []);
    const events = await collect(agent, { input: 'hi' });

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(1);
    expect(textDeltas.map((e) => (e as { text: string }).text).join('')).toBe('Hello there, world.');
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);
    expect(events[0]?.type).toBe('run_start');
    expect(events.at(-1)?.type).toBe('run_end');
  });

  it('run is stream drained, so both agree', async () => {
    const { agent } = agentWith([{ text: 'same' }], []);
    const events = await collect(agent, { input: 'x' });
    const fromStream = events.find((e) => e.type === 'run_end');
    expect(fromStream && 'result' in fromStream ? fromStream.result.text : '').toBe('same');
  });

  it('surfaces a router error event as a warning rather than retrying it', async () => {
    const { agent, router } = agentWith(
      [{ text: 'recovered', error: { message: 'rate limited (429)', code: 'E_MODEL_UNAVAILABLE', retryable: true } }],
      [],
    );
    const events = await collect(agent, { input: 'x' });
    expect(events.some((e) => e.type === 'warning' && e.message.includes('429'))).toBe(true);
    expect(router.requests).toHaveLength(1);
  });

  it('builds a response from the deltas when the stream never says done', async () => {
    const { agent } = agentWith([{ text: 'partial answer', omitDone: true }], []);
    const result = await agent.run({ input: 'x' });
    expect(result.text).toBe('partial answer');
    expect(result.stopReason).toBe('complete');
  });
});

describe('Agent: parallel tools', () => {
  it('runs calls concurrently but appends results in the model order', async () => {
    const calls = [
      toolCall('c1', 'slow', { value: '1' }),
      toolCall('c2', 'quick', { value: '2' }),
      toolCall('c3', 'quick', { value: '3' }),
      toolCall('c4', 'slow', { value: '4' }),
    ];
    const { agent } = agentWith(
      [{ text: 'batching', toolCalls: calls }, { text: 'done' }],
      [echo('slow', { delayMs: 40 }), echo('quick')],
    );

    const started = Date.now();
    const result = await agent.run({ input: 'go' });
    const elapsed = Date.now() - started;

    expect(toolResults(result.messages).map((r) => r.toolCallId)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(toolResults(result.messages).map((r) => r.content)).toEqual(['slow:1', 'quick:2', 'quick:3', 'slow:4']);
    // Two 40ms tools in parallel finish well under the 80ms they would take serially.
    expect(elapsed).toBeLessThan(120);
  });

  it('caps concurrency at four', async () => {
    let live = 0;
    let peak = 0;
    const counter = defineTool<Record<string, never>, string>({
      name: 'counter',
      description: 'counts',
      parameters: { type: 'object', properties: {} },
      async handler(_i, ctx) {
        live += 1;
        peak = Math.max(peak, live);
        await abortableDelay(20, ctx.signal);
        live -= 1;
        return 'ok';
      },
    });
    const calls = Array.from({ length: 9 }, (_, i) => toolCall(`c${i}`, 'counter'));
    const { agent } = agentWith([{ toolCalls: calls }, { text: 'done' }], [counter]);
    await agent.run({ input: 'go' });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('Agent: ceilings', () => {
  const loopForever: ScriptedTurn[] = Array.from({ length: 40 }, (_, i) => ({
    text: `turn ${i}`,
    toolCalls: [toolCall(`c${i}`, 'echo', { value: String(i) })],
  }));

  it('stops at the step ceiling', async () => {
    const { agent, router } = agentWith([...loopForever], [echo('echo')], {});
    const result = await agent.run({ input: 'go', maxSteps: 3 });
    expect(result.stopReason).toBe('step_limit');
    expect(result.steps).toBe(3);
    expect(router.requests).toHaveLength(3);
  });

  it('stops on cost before making the call that would breach it', async () => {
    const turns = loopForever.map((t) => ({ ...t, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.4 } }));
    const { agent, router } = agentWith(turns, [echo('echo')]);
    const result = await agent.run({ input: 'go', maxCostUsd: 0.5, maxSteps: 20 });

    expect(result.stopReason).toBe('budget');
    expect(result.error?.code).toBe('E_BUDGET_EXCEEDED');
    // A second call would take us to $0.80. The ceiling is never breached --
    // the old loop only noticed afterwards, by which point it had overspent.
    expect(router.requests).toHaveLength(1);
    expect(result.usage.costUsd ?? 0).toBeLessThanOrEqual(0.5);
  });

  it('refuses even the first call when the price table says it cannot afford it', async () => {
    const router = new FakeRouter([{ text: 'never sent' }], {
      id: 'anthropic/expensive',
      provider: 'anthropic',
      name: 'expensive',
      displayName: 'Expensive',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      pricing: { inputPerMTok: 5000, outputPerMTok: 25_000 },
    });
    const agent = new Agent({ spec: specFor(), router, tools: [], logger: silent });
    const result = await agent.run({ input: 'go', maxCostUsd: 0.001 });

    expect(result.stopReason).toBe('budget');
    expect(router.requests).toHaveLength(0);
    expect(result.usage.costUsd).toBe(0);
  });

  it('stops on the token ceiling', async () => {
    const turns = loopForever.map((t) => ({ ...t, usage: { inputTokens: 4000, outputTokens: 1000, costUsd: 0 } }));
    const { agent } = agentWith(turns, [echo('echo')]);
    const result = await agent.run({ input: 'go', maxTokens: 8000, maxSteps: 20 });
    expect(result.stopReason).toBe('budget');
    expect(result.usage.inputTokens + result.usage.outputTokens).toBeLessThanOrEqual(10_000);
  });

  it('stops on the wall clock and aborts the in-flight request', async () => {
    const { agent } = agentWith([{ text: 'slow', delayMs: 2000 }], []);
    const started = Date.now();
    const result = await agent.run({ input: 'go', timeoutSec: 0.15 });
    expect(result.stopReason).toBe('timeout');
    // If the request were merely raced rather than aborted, this would take 2s.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports an external abort as aborted', async () => {
    const ac = new AbortController();
    const { agent } = agentWith([{ text: 'slow', delayMs: 2000 }], []);
    setTimeout(() => ac.abort(), 30);
    const result = await agent.run({ input: 'go', signal: ac.signal });
    expect(result.stopReason).toBe('aborted');
  });

  it('passes the run signal into tool handlers', async () => {
    let seen: AbortSignal | undefined;
    const probe = defineTool<Record<string, never>, string>({
      name: 'probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      async handler(_i, ctx) {
        seen = ctx.signal;
        return 'ok';
      },
    });
    const { agent } = agentWith([{ toolCalls: [toolCall('c1', 'probe')] }, { text: 'done' }], [probe]);
    await agent.run({ input: 'go' });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });
});

describe('Agent: approval', () => {
  const turns: ScriptedTurn[] = [
    { text: 'about to write', toolCalls: [toolCall('c1', 'danger', { value: 'x' })] },
    { text: 'done' },
  ];

  it('denies a dangerous tool in ask mode when no approver is wired', async () => {
    const tool = echo('danger', { dangerous: true });
    const { agent } = agentWith([...turns], [tool]);
    const events = await collect(agent, { input: 'go', approvalMode: 'ask' });

    const denied = events.find((e) => e.type === 'tool_denied');
    expect(denied).toBeDefined();
    expect((denied as { reason: string }).reason).toContain('no approver');
    const result = (events.at(-1) as { result: { messages: ModelMessage[] } }).result;
    expect(toolResults(result.messages)[0]).toMatchObject({ isError: true });
    expect(toolResults(result.messages)[0]?.content).toContain('Denied');
  });

  it('runs a dangerous tool in ask mode when the approver says yes', async () => {
    const { agent } = agentWith([...turns], [echo('danger', { dangerous: true })]);
    const onApproval = vi.fn(async (_req: ApprovalRequest) => true);
    const result = await agent.run({ input: 'go', approvalMode: 'ask', onApproval });
    expect(onApproval).toHaveBeenCalledOnce();
    expect(onApproval.mock.calls[0]?.[0]).toMatchObject({ tool: 'danger', dangerous: true });
    expect(toolResults(result.messages)[0]).toMatchObject({ content: 'danger:x', isError: false });
  });

  it('denies when the approver says no', async () => {
    const { agent } = agentWith([...turns], [echo('danger', { dangerous: true })]);
    const result = await agent.run({ input: 'go', approvalMode: 'ask', onApproval: async () => false });
    expect(toolResults(result.messages)[0]?.content).toContain('declined');
  });

  it('treats an approver that throws as a refusal', async () => {
    const { agent } = agentWith([...turns], [echo('danger', { dangerous: true })]);
    const result = await agent.run({
      input: 'go',
      approvalMode: 'ask',
      onApproval: async () => {
        throw new Error('the UI went away');
      },
    });
    expect(toolResults(result.messages)[0]).toMatchObject({ isError: true });
  });

  it('denies every dangerous tool in readonly mode, approver or not', async () => {
    const onApproval = vi.fn(async () => true);
    const { agent } = agentWith([...turns], [echo('danger', { dangerous: true })]);
    const result = await agent.run({ input: 'go', approvalMode: 'readonly', onApproval });
    expect(onApproval).not.toHaveBeenCalled();
    expect(toolResults(result.messages)[0]?.content).toContain('readonly');
  });

  it('still runs safe tools in readonly mode', async () => {
    const { agent } = agentWith(
      [{ toolCalls: [toolCall('c1', 'safe', { value: 'y' })] }, { text: 'done' }],
      [echo('safe')],
    );
    const result = await agent.run({ input: 'go', approvalMode: 'readonly' });
    expect(toolResults(result.messages)[0]).toMatchObject({ content: 'safe:y', isError: false });
  });

  it('takes the approval mode from the spec when the caller does not override it', async () => {
    const { agent } = agentWith([...turns], [echo('danger', { dangerous: true })], {
      guardrails: { approvalMode: 'readonly' } as never,
    });
    const result = await agent.run({ input: 'go' });
    expect(toolResults(result.messages)[0]).toMatchObject({ isError: true });
  });

  it('ctx.confirm resolves false when no approver is wired', async () => {
    let answer: boolean | undefined;
    const asker = defineTool<Record<string, never>, string>({
      name: 'asker',
      description: 'asks',
      parameters: { type: 'object', properties: {} },
      async handler(_i, ctx) {
        answer = await ctx.confirm('really?');
        return String(answer);
      },
    });
    const { agent } = agentWith([{ toolCalls: [toolCall('c1', 'asker')] }, { text: 'done' }], [asker]);
    await agent.run({ input: 'go', approvalMode: 'ask' });
    expect(answer).toBe(false);
  });
});

describe('Agent: repetition breaker', () => {
  function repeats(n: number): ScriptedTurn[] {
    return Array.from({ length: n }, () => ({
      text: 'trying again',
      toolCalls: [toolCall('c', 'echo', { value: 'same' })],
    }));
  }

  it('nudges the model on the third identical turn', async () => {
    const { agent, router } = agentWith([...repeats(3), { text: 'fine, something else' }], [echo('echo')]);
    const events = await collect(agent, { input: 'go', maxSteps: 10 });

    expect(events.some((e) => e.type === 'warning' && e.message.includes('nudging'))).toBe(true);
    const fourth = router.requests[3]!;
    const nudge = fourth.messages.filter((m) => m.role === 'user').at(-1);
    expect(String(nudge?.content)).toContain('byte-identical');
    expect(String(nudge?.content)).toContain('echo');
  });

  it('gives up after five identical turns', async () => {
    const { agent } = agentWith(repeats(8), [echo('echo')]);
    const result = await agent.run({ input: 'go', maxSteps: 20 });
    expect(result.steps).toBe(5);
    expect(result.stopReason).toBe('error');
    expect(result.error?.message).toContain('5 times in a row');
  });

  it('ignores key order when comparing arguments', async () => {
    const a: ToolCallPart = { type: 'tool_call', id: 'c', name: 'echo', args: { a: 1, b: 2 } as never };
    const b: ToolCallPart = { type: 'tool_call', id: 'c', name: 'echo', args: { b: 2, a: 1 } as never };
    const { agent } = agentWith(
      [{ toolCalls: [a] }, { toolCalls: [b] }, { toolCalls: [a] }, { text: 'stop' }],
      [echo('echo')],
    );
    const events = await collect(agent, { input: 'go', maxSteps: 10 });
    expect(events.some((e) => e.type === 'warning' && e.message.includes('nudging'))).toBe(true);
  });

  it('does not fire when the arguments actually change', async () => {
    const turns: ScriptedTurn[] = [1, 2, 3, 4].map((n) => ({
      toolCalls: [toolCall('c', 'echo', { value: String(n) })],
    }));
    const { agent } = agentWith([...turns, { text: 'done' }], [echo('echo')]);
    const events = await collect(agent, { input: 'go', maxSteps: 10 });
    expect(events.some((e) => e.type === 'warning')).toBe(false);
  });
});

describe('Agent: tool output handling', () => {
  it('redacts credentials before they reach the model', async () => {
    const leaky = defineTool<Record<string, never>, string>({
      name: 'leaky',
      description: 'leaks',
      parameters: { type: 'object', properties: {} },
      async handler() {
        return 'export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz012345';
      },
    });
    const { agent, router } = agentWith([{ toolCalls: [toolCall('c1', 'leaky')] }, { text: 'ok' }], [leaky]);
    const result = await agent.run({ input: 'go' });

    expect(toolResults(result.messages)[0]?.content).toContain('[redacted]');
    expect(JSON.stringify(router.requests[1]?.messages)).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('leaves output alone when redactSecrets is off', async () => {
    const leaky = defineTool<Record<string, never>, string>({
      name: 'leaky',
      description: 'leaks',
      parameters: { type: 'object', properties: {} },
      async handler() {
        return 'sk-ant-abcdefghijklmnopqrstuvwxyz012345';
      },
    });
    const { agent } = agentWith([{ toolCalls: [toolCall('c1', 'leaky')] }, { text: 'ok' }], [leaky], {
      guardrails: { redactSecrets: false } as never,
    });
    const result = await agent.run({ input: 'go' });
    expect(toolResults(result.messages)[0]?.content).not.toContain('[redacted]');
  });

  it('clamps output to the husk byte ceiling', async () => {
    const chatty = defineTool<Record<string, never>, string>({
      name: 'chatty',
      description: 'chatty',
      parameters: { type: 'object', properties: {} },
      async handler() {
        return 'x'.repeat(50_000);
      },
    });
    const { agent } = agentWith([{ toolCalls: [toolCall('c1', 'chatty')] }, { text: 'ok' }], [chatty], {
      limits: { maxOutputBytes: 2048 } as never,
    });
    const result = await agent.run({ input: 'go' });
    const content = toolResults(result.messages)[0]!.content;
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(2048);
    expect(content).toContain('elided by husk');
  });

  it('turns a tool failure into an error result instead of killing the run', async () => {
    const broken = defineTool<Record<string, never>, string>({
      name: 'broken',
      description: 'broken',
      parameters: { type: 'object', properties: {} },
      async handler() {
        throw new Error('disk on fire');
      },
    });
    const { agent } = agentWith([{ toolCalls: [toolCall('c1', 'broken')] }, { text: 'recovered' }], [broken]);
    const result = await agent.run({ input: 'go' });
    expect(result.stopReason).toBe('complete');
    expect(toolResults(result.messages)[0]).toMatchObject({ isError: true });
    expect(toolResults(result.messages)[0]?.content).toContain('disk on fire');
  });

  it('names the available tools when the model invents one', async () => {
    const { agent } = agentWith([{ toolCalls: [toolCall('c1', 'nope')] }, { text: 'ok' }], [echo('echo')]);
    const result = await agent.run({ input: 'go' });
    const content = toolResults(result.messages)[0]!.content;
    expect(content).toContain('no tool named "nope"');
    expect(content).toContain('echo');
  });
});

describe('Agent: system prompt and examples', () => {
  it('renders the persona with vars and turns examples into alternating turns', async () => {
    const spec = specFor({
      persona: 'You are {{role}}.',
      examples: [{ user: 'ping', assistant: 'pong' }],
    });
    const router = new FakeRouter([{ text: 'ok' }]);
    const agent = new Agent({ spec, router, tools: [], logger: silent });
    await agent.run({ input: 'go', vars: { role: 'a linter' } });

    const req = router.requests[0]!;
    expect(req.system).toContain('You are a linter.');
    expect(req.messages.slice(0, 3)).toEqual([
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: 'go' },
    ]);
  });

  it('places prior history after the examples and before the new input', async () => {
    const spec = specFor({ examples: [{ user: 'ping', assistant: 'pong' }] });
    const router = new FakeRouter([{ text: 'ok' }]);
    const agent = new Agent({ spec, router, tools: [], logger: silent });
    await agent.run({ input: 'now', history: [{ role: 'user', content: 'earlier' }] });
    expect(router.requests[0]!.messages.map((m) => m.content)).toEqual(['ping', 'pong', 'earlier', 'now']);
  });
});

describe('Agent: lazy computer', () => {
  it('never touches the computer source when no tool needs it', async () => {
    const computers = new FakeComputerSource();
    const agent = new Agent({ spec: specFor(), router: new FakeRouter([{ text: 'hi' }]), computers, tools: [], logger: silent });
    const events = await collect(agent, { input: 'go' });
    expect(computers.calls).toBe(0);
    expect(events.some((e) => e.type === 'computer_ready')).toBe(false);
  });

  it('materialises one machine for a parallel batch and announces it once', async () => {
    const computers = new FakeComputerSource();
    const needsBox = defineTool<Record<string, never>, string>({
      name: 'box',
      description: 'uses the machine',
      needsComputer: true,
      parameters: { type: 'object', properties: {} },
      async handler(_i, ctx) {
        const c = await ctx.acquireComputer();
        return c.id;
      },
    });
    const calls = [toolCall('a', 'box'), toolCall('b', 'box'), toolCall('c', 'box')];
    const agent = new Agent({
      spec: specFor(),
      router: new FakeRouter([{ toolCalls: calls }, { text: 'done' }]),
      computers,
      tools: [needsBox] as never,
      logger: silent,
    });

    const events = await collect(agent, { input: 'go' });
    expect(computers.calls).toBe(1);
    expect(events.filter((e) => e.type === 'computer_ready')).toHaveLength(1);
  });

  it('explains itself when a tool wants a machine the husk does not have', async () => {
    const needsBox = defineTool<Record<string, never>, string>({
      name: 'box',
      description: 'uses the machine',
      needsComputer: true,
      parameters: { type: 'object', properties: {} },
      async handler(_i, ctx) {
        const c = await ctx.acquireComputer();
        return c.id;
      },
    });
    const agent = new Agent({
      spec: specFor(),
      router: new FakeRouter([{ toolCalls: [toolCall('a', 'box')] }, { text: 'done' }]),
      tools: [needsBox] as never,
      logger: silent,
    });
    const result = await agent.run({ input: 'go' });
    const content = toolResults(result.messages)[0]!.content;
    expect(content).toContain('has no computer');
    expect(content).toContain('Hint:');
  });
});

describe('Agent: memory', () => {
  it('trims history mid-run without orphaning a tool result', async () => {
    const history: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: `q${i}` });
      history.push({
        role: 'assistant',
        content: [{ type: 'tool_call', id: `t${i}`, name: 'echo', args: {} }],
      });
      history.push({ role: 'tool', content: [{ type: 'tool_result', toolCallId: `t${i}`, content: 'ok' }] });
    }

    const router = new FakeRouter([{ text: 'ok' }]);
    const agent = new Agent({
      spec: specFor({ memory: { enabled: true, windowTurns: 2, summarise: false, backend: 'memory' } as never }),
      router,
      tools: [echo('echo')] as never,
      logger: silent,
    });
    await agent.run({ input: 'latest', history });

    const sent = router.requests[0]!.messages;
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of sent) {
      if (typeof m.content === 'string') continue;
      for (const p of m.content) {
        if (p.type === 'tool_call') callIds.add(p.id);
        if (p.type === 'tool_result') resultIds.add(p.toolCallId);
      }
    }
    expect(callIds).toEqual(resultIds);
    expect(sent.length).toBeLessThan(history.length);
  });

  it('summarises with a cheap model when asked', async () => {
    const history: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: `q${i}` });
      history.push({ role: 'assistant', content: `a${i}` });
    }
    const router = new FakeRouter([{ text: 'ok' }]);
    const agent = new Agent({
      spec: specFor({ memory: { enabled: true, windowTurns: 2, summarise: true, backend: 'memory' } as never }),
      router,
      tools: [],
      summaryModel: 'haiku',
      logger: silent,
    });
    await agent.run({ input: 'latest', history });

    expect(router.chatRequests[0]?.model).toBe('haiku');
    expect(JSON.stringify(router.requests[0]!.messages)).toContain('a summary of the middle');
  });
});

describe('model tool-capability guard', () => {
  const gemma = {
    id: 'ollama/gemma3',
    provider: 'ollama',
    name: 'gemma3',
    displayName: 'Gemma 3',
    contextWindow: 8192,
    maxOutputTokens: 2048,
    supportsTools: false,
    supportsVision: true,
    supportsStreaming: true,
    free: true,
  };
  const qwen = { ...gemma, id: 'ollama/qwen2.5:7b', name: 'qwen2.5:7b', supportsTools: true };

  it('refuses before the first token when the model cannot call tools', async () => {
    // gemma3 reports only `vision` in Ollama. Without this guard the run spends
    // minutes of local inference and then fails with the model narrating what it
    // would have done -- which reads like a husk bug rather than a model choice.
    const router = new FakeRouter([{ text: 'should never be sent' }], gemma);
    const agent = new Agent({
      spec: specFor({ model: 'ollama/gemma3', tools: ['files'] }),
      router,
      computers: new FakeComputerSource(),
      logger: silent,
    });

    const result = await agent.run({ input: 'hello' });
    expect(result.stopReason).toBe('error');
    expect(result.error?.message).toMatch(/cannot call tools/);
    expect(result.steps).toBe(0);
    expect(router.requests).toHaveLength(0);
  });

  it('runs normally when the model does support tools', async () => {
    const router = new FakeRouter([{ text: 'fine' }], qwen);
    const agent = new Agent({
      spec: specFor({ model: 'ollama/qwen2.5:7b', tools: ['files'] }),
      router,
      computers: new FakeComputerSource(),
      logger: silent,
    });
    expect((await agent.run({ input: 'hello' })).stopReason).toBe('complete');
  });

  it('does not block a chat-only husk on the same model', async () => {
    // `gemma` stays a usable alias -- it just cannot be handed tools.
    const router = new FakeRouter([{ text: 'chat only' }], gemma);
    const agent = new Agent({
      spec: specFor({ model: 'ollama/gemma3', tools: [] }),
      router,
      tools: [],
      logger: silent,
    });
    expect((await agent.run({ input: 'hello' })).stopReason).toBe('complete');
  });
});
