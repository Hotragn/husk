import { describe, expect, it, vi } from 'vitest';
import { parseSpec } from '@husk-ai/core';
import type { ChatRequest, ChatResponse, Transcript, TranscriptMessage } from '@husk-ai/core';
import {
  DIRECTIVES,
  distill,
  distillHeuristic,
  distillWithModel,
  humanTurns,
  mineExamples,
  mineKnowledge,
  mineRules,
  modelAlias,
  observedTools,
  toSpec,
  windowMessages,
} from './distill.js';

function t(messages: TranscriptMessage[], extra: Partial<Transcript> = {}): Transcript {
  return { id: 's1', source: 'claude-code', title: 'Release runbook', messages, ...extra };
}

const RUNBOOK = t([
  {
    role: 'user',
    content:
      'You are the release engineer for this repo. Always run the full test suite before you tag. Never force-push to main.',
  },
  { role: 'assistant', content: 'Understood. I will run the suite and tag only when it is green.' },
  { role: 'assistant', content: '[tool: Bash]', toolName: 'Bash', toolInput: { command: 'npm test' } },
  { role: 'tool', content: '42 passing', toolName: 'Bash' },
  {
    role: 'user',
    content:
      'Here is the deploy topology you need to know:\n- api runs on fly.io in iad\n- the worker is a systemd unit on box-3\n- secrets live in 1Password, never in the repo\n- the changelog lives at docs/CHANGELOG.md and is generated, not written by hand',
  },
  {
    role: 'assistant',
    content: 'Noted. I will treat docs/CHANGELOG.md as generated output and leave it alone during a release.',
  },
  { role: 'user', content: 'Always run the full test suite before you tag.' },
  { role: 'assistant', content: 'Yes. That is the first step of every release I do.' },
  { role: 'assistant', content: '[tool: Read]', toolName: 'Read', toolInput: { file_path: '/work/package.json' } },
  { role: 'tool', content: '{"version":"1.2.3"}', toolName: 'Read' },
  { role: 'user', content: 'Cut 1.2.4 now.' },
  { role: 'assistant', content: 'Tagging v1.2.4 after a green suite and updating the release notes.' },
]);

describe('humanTurns', () => {
  it('keeps only what a person typed', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', content: 'real question' },
      { role: 'user', content: '<system-reminder>injected</system-reminder>' },
      { role: 'user', content: '[Request interrupted by user for tool use]' },
      { role: 'tool', content: 'output', toolName: 'Bash' },
      { role: 'assistant', content: 'answer' },
    ];
    expect(humanTurns(messages).map((m) => m.content)).toEqual(['real question']);
  });

  it('trusts promptSource over the text heuristics when the importer set it', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', content: 'typed by a person', meta: { promptSource: 'typed' } },
      { role: 'user', content: 'Base directory for this skill: /tmp/x\n\n# A skill doc' },
    ];
    expect(humanTurns(messages).map((m) => m.content)).toEqual(['typed by a person']);
  });
});

describe('mineRules', () => {
  it('finds always / never / you-are instructions', () => {
    const rules = mineRules(RUNBOOK.messages);
    const texts = rules.map((r) => r.text);
    expect(texts.some((x) => /Always run the full test suite/i.test(x))).toBe(true);
    expect(texts.some((x) => /Never force-push to main/i.test(x))).toBe(true);
    expect(rules.some((r) => r.kind === 'identity')).toBe(true);
  });

  it('ranks a repeated instruction above a one-off', () => {
    const rules = mineRules(RUNBOOK.messages);
    const repeated = rules.find((r) => /full test suite/i.test(r.text));
    expect(repeated?.occurrences).toBe(2);
    const once = rules.find((r) => /force-push/i.test(r.text));
    expect(repeated!.score).toBeGreaterThan(once!.score);
  });

  it('ignores instructions inside a correction', () => {
    const rules = mineRules([
      { role: 'user', content: 'No, that is wrong. Always use tabs.' },
      { role: 'user', content: 'Always use spaces.' },
    ]);
    expect(rules.map((r) => r.text)).toEqual(['Always use spaces.']);
  });

  it('does not mine the assistant', () => {
    expect(mineRules([{ role: 'assistant', content: 'You are always right about that.' }])).toEqual([]);
  });
});

describe('mineKnowledge', () => {
  it('takes durable facts the user supplied', () => {
    const knowledge = mineKnowledge(RUNBOOK.messages);
    expect(knowledge).toHaveLength(1);
    expect(knowledge[0]?.content).toContain('systemd unit on box-3');
  });

  it('ignores short chatter', () => {
    expect(mineKnowledge([{ role: 'user', content: 'thanks!' }])).toEqual([]);
  });
});

describe('mineExamples', () => {
  it('pairs a user turn with the assistant prose that answered it', () => {
    const examples = mineExamples(RUNBOOK.messages);
    expect(examples.length).toBeGreaterThan(0);
    expect(examples[0]?.user).toContain('You are the release engineer');
    expect(examples[0]?.assistant).toContain('I will run the suite');
  });

  it('skips a turn the user immediately corrected', () => {
    const examples = mineExamples([
      { role: 'user', content: 'Summarise the incident report for the exec team.' },
      { role: 'assistant', content: 'THIS ANSWER WAS WRONG AND THE USER SAID SO IMMEDIATELY AFTERWARDS.' },
      { role: 'user', content: 'No, that is not what I asked for. Try again.' },
      { role: 'assistant', content: 'Here is a two-paragraph summary aimed at the exec team, with the impact first.' },
      { role: 'user', content: 'Better, thanks.' },
    ]);
    expect(examples.map((e) => e.assistant).join()).not.toContain('THIS ANSWER WAS WRONG');
  });
});

describe('observedTools', () => {
  it('maps shell to computer, file tools to files, web tools to web', () => {
    const tools = observedTools(
      t([], { meta: { tools: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch'] } }),
    );
    expect(tools.suggested).toEqual(['computer', 'files', 'web']);
    expect(tools.needsComputer).toBe(true);
  });

  it('drops orchestration plumbing and keeps unknown tool names verbatim', () => {
    const tools = observedTools(t([], { meta: { tools: ['Task', 'TodoWrite', 'mcp__linear__create_issue'] } }));
    expect(tools.suggested).toEqual(['mcp__linear__create_issue']);
    expect(tools.needsComputer).toBe(false);
  });

  it('includes tools that only a sidechain revealed', () => {
    const tools = observedTools(t([], { meta: { tools: ['Bash'], sidechainTools: ['WebSearch'] } }));
    expect(tools.suggested).toEqual(['computer', 'web']);
  });
});

describe('distillHeuristic', () => {
  const agent = distillHeuristic(RUNBOOK);

  it('produces a persona built from the user standing instructions', () => {
    expect(agent.persona).toContain('release engineer');
    expect(agent.persona).toMatch(/Always run the full test suite/i);
    expect(agent.persona).toMatch(/Never force-push to main/i);
  });

  it('derives tools from observed usage and sets needsComputer', () => {
    expect(agent.suggestedTools).toEqual(['computer', 'files']);
    expect(agent.needsComputer).toBe(true);
  });

  it('reports an honest confidence, never a perfect one', () => {
    expect(agent.confidence).toBeGreaterThan(0.3);
    expect(agent.confidence).toBeLessThanOrEqual(0.75);
  });

  it('says what it could not work out', () => {
    const bare = distillHeuristic(t([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]));
    expect(bare.notes.join(' ')).toMatch(/No recurring standing instructions/);
    expect(bare.notes.join(' ')).toMatch(/no model was used/i);
    expect(bare.confidence).toBeLessThan(0.2);
  });

  it('needs no model and no network', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    distillHeuristic(RUNBOOK);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('redacts by default', () => {
    const secretive = distillHeuristic(
      t([
        { role: 'user', content: 'You are a helper. Always write output to C:\\Users\\bob\\out and mail bob@example.com.' },
        { role: 'assistant', content: 'Understood, writing there and mailing on completion of every run.' },
      ]),
    );
    expect(agentText(secretive)).not.toContain('bob@example.com');
    expect(agentText(secretive)).not.toContain('C:\\Users\\bob');
  });

  it('picks up the model the transcript ran on', () => {
    const withModel = distillHeuristic(t(RUNBOOK.messages, { meta: { model: 'claude-opus-5' } }));
    expect(withModel.suggestedModel).toBe('opus');
  });
});

function agentText(a: ReturnType<typeof distillHeuristic>): string {
  return JSON.stringify(a);
}

describe('modelAlias', () => {
  it('maps observed model ids onto husk aliases', () => {
    expect(modelAlias('claude-opus-5')).toBe('opus');
    expect(modelAlias('claude-sonnet-5')).toBe('sonnet');
    expect(modelAlias('gpt-4.1')).toBe('gpt');
    expect(modelAlias('gemini-2.5-flash')).toBe('flash');
    expect(modelAlias('some-local-thing')).toBeUndefined();
  });
});

describe('toSpec', () => {
  it('always produces something parseSpec accepts', () => {
    const spec = toSpec(distillHeuristic(RUNBOOK), { transcript: RUNBOOK });
    expect(() => parseSpec(spec)).not.toThrow();
    expect(spec.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('fills origin provenance from the transcript', () => {
    const spec = toSpec(distillHeuristic(RUNBOOK), { transcript: { ...RUNBOOK, origin: '/p/s.jsonl' } });
    expect(spec.origin).toMatchObject({ source: '/p/s.jsonl', transcriptId: 's1', messageCount: RUNBOOK.messages.length });
    expect(spec.origin?.importedAt).toBeTruthy();
  });

  it('survives a name the schema would reject', () => {
    const spec = toSpec({ ...distillHeuristic(RUNBOOK), name: '!!! 42 ???' });
    expect(() => parseSpec(spec)).not.toThrow();
    expect(spec.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('applies overrides on top', () => {
    const spec = toSpec(distillHeuristic(RUNBOOK), { model: 'sonnet', limits: { maxSteps: 99 } });
    expect(spec.model).toBe('sonnet');
    expect(spec.limits.maxSteps).toBe(99);
    // Untouched defaults survive the merge.
    expect(spec.limits.maxCostUsd).toBe(0.5);
  });

  it('turns needsComputer into the computer block', () => {
    expect(toSpec(distillHeuristic(RUNBOOK)).computer.enabled).toBe(true);
    const noTools = distillHeuristic(t([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]));
    expect(toSpec(noTools).computer.enabled).toBe(false);
  });
});

describe('windowMessages', () => {
  const many: TranscriptMessage[] = Array.from({ length: 500 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `message ${i} `.repeat(40),
  }));

  it('covers every message, never just the first N', () => {
    const windows = windowMessages(many, 2000, 0);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.flat()).toHaveLength(many.length);
    expect(windows.at(-1)?.at(-1)?.content).toBe(many.at(-1)?.content);
  });

  it('repeats overlap messages at each boundary', () => {
    const windows = windowMessages(many, 2000, 2);
    expect(windows[1]?.slice(0, 2)).toEqual(windows[0]?.slice(-2));
  });

  it('handles a transcript smaller than one window', () => {
    expect(windowMessages(many.slice(0, 2), 100_000, 2)).toHaveLength(1);
  });
});

function stubModel(replies: string[]): { chat: (req: ChatRequest) => Promise<ChatResponse>; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  return {
    calls,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      calls.push(req);
      const text = replies[Math.min(i++, replies.length - 1)] ?? '';
      return {
        model: 'stub',
        text,
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 0,
      };
    },
  };
}

describe('distillWithModel', () => {
  const candidate = JSON.stringify({
    name: 'release-bot',
    description: 'Cuts releases',
    personaRules: ['Always run the full test suite before tagging.'],
    knowledge: [{ title: 'Topology', content: 'api on fly.io' }],
    examples: [{ user: 'cut 1.2.4', assistant: 'tagging' }],
    tools: ['Bash'],
    needsComputer: true,
    notes: [],
  });
  const merged = JSON.stringify({
    name: 'release-bot',
    description: 'Cuts releases for this repo',
    persona: 'You are the release engineer.\n- Always run the full test suite before tagging.',
    personaRules: ['Always run the full test suite before tagging.'],
    knowledge: [{ title: 'Topology', content: 'api on fly.io' }],
    examples: [{ user: 'cut 1.2.4', assistant: 'tagging' }],
    tools: ['Bash'],
    needsComputer: true,
    confidence: 0.82,
    notes: ['one window only'],
  });

  it('maps over windows then reduces once', async () => {
    const model = stubModel([candidate, merged]);
    const agent = await distillWithModel(RUNBOOK, model);
    expect(model.calls).toHaveLength(2);
    expect(agent.name).toBe('release-bot');
    expect(agent.confidence).toBeCloseTo(0.82);
    expect(agent.persona).toContain('release engineer');
  });

  it('keeps observed tools even when the model omits them', async () => {
    const agent = await distillWithModel(RUNBOOK, stubModel([candidate, merged]));
    expect(agent.suggestedTools).toContain('computer');
    expect(agent.suggestedTools).toContain('files');
  });

  it('falls back to the heuristic path when the model returns junk', async () => {
    const agent = await distillWithModel(RUNBOOK, stubModel(['not json at all']));
    expect(agent.notes.join(' ')).toMatch(/fell back to heuristics/);
    expect(agent.persona).toMatch(/Always run the full test suite/i);
  });

  it('falls back rather than throwing when the model errors', async () => {
    const agent = await distillWithModel(RUNBOOK, {
      chat: async () => {
        throw new Error('502 from provider');
      },
    });
    expect(agent.confidence).toBeGreaterThan(0);
    expect(agent.notes.join(' ')).toMatch(/fell back to heuristics/);
  });

  it('merges deterministically when only the reduce pass fails', async () => {
    const agent = await distillWithModel(RUNBOOK, stubModel([candidate, 'garbage']));
    expect(agent.notes.join(' ')).toMatch(/merged deterministically/);
    expect(agent.persona).toMatch(/Always run the full test suite/i);
  });

  it('sends every window, not just the first', async () => {
    const long = t(
      Array.from(
        { length: 300 },
        (_, i): TranscriptMessage => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} `.repeat(30) }),
      ),
    );
    const model = stubModel([candidate, candidate, candidate, candidate, candidate, merged]);
    await distillWithModel(long, model, { windowTokens: 4000 });
    const extractCalls = model.calls.filter((c) => c.system?.startsWith('You read one slice'));
    expect(extractCalls.length).toBeGreaterThan(1);
    const seen = extractCalls.map((c) => String(c.messages[0]?.content)).join('\n');
    expect(seen).toContain('turn 299');
  });
});

describe('distill', () => {
  it('uses the free path with no router', async () => {
    const agent = await distill(RUNBOOK);
    expect(agent.notes.join(' ')).toMatch(/no model was used/i);
  });
});

// -- harness scaffolding must not reach the husk -----------------------------

describe('mining respects the speaker', () => {
  it('does not turn assistant prose into persona guidance', () => {
    const agent = distillHeuristic(
      t([
        { role: 'user', content: 'Summarise what you changed.' },
        {
          role: 'assistant',
          content:
            'Always run the cost test before shipping. Never emit a warning event from the router. You are required to keep the ceiling intact. Make sure the approver is consulted every time.',
        },
        { role: 'user', content: 'Thanks, that reads fine.' },
      ]),
    );
    expect(agent.persona).not.toMatch(/Always run the cost test/i);
    expect(agent.persona).not.toMatch(/Never emit a warning event/i);
    expect(agent.persona).not.toMatch(/Make sure the approver/i);
    expect(agent.notes.join(' ')).toMatch(/No recurring standing instructions/);
  });

  it('mines the same sentence when the user is the one who said it', () => {
    const rules = mineRules([
      { role: 'user', content: 'Always run the cost test before shipping.' },
    ]);
    expect(rules.map((r) => r.text)).toContain('Always run the cost test before shipping.');
  });

  it('ignores a subagent completion report filed under the user role', () => {
    const report = [
      '<task-notification>',
      '<task-id>a207096b99b0f9aa0</task-id>',
      '<tool-use-id>toolu_01VMSUooodxpFaGNWuLZKtFL</tool-use-id>',
      '<summary>Agent "Build @husk-ai/models" finished</summary>',
      '<result>Always assert the cost ceiling is never crossed.</result>',
      '</task-notification>',
    ].join('\n');
    expect(humanTurns([{ role: 'user', content: report }])).toEqual([]);
    expect(mineRules([{ role: 'user', content: report }])).toEqual([]);
  });
});

describe('knowledge quality floor', () => {
  const preamble =
    'The deploy runbook for the billing service, which everyone on the team should follow without exception, is written up as follows and kept current: ';

  function knowledgeFrom(body: string) {
    return mineKnowledge([{ role: 'user', content: preamble + body }]);
  }

  it('rejects a candidate carrying a tool-use id', () => {
    expect(
      knowledgeFrom('- the run id was toolu_0117qfiw98YCkUJY4sdipUaT\n- see the log at https://ci.example.com/1'),
    ).toEqual([]);
  });

  it('rejects a candidate carrying a task-id tag', () => {
    expect(knowledgeFrom('- <task-id>a207096b99b0f9aa0</task-id>\n- https://ci.example.com/2')).toEqual([]);
  });

  it('rejects a candidate carrying an absolute temp path', () => {
    expect(
      knowledgeFrom(
        `- output lands in ${String.raw`C:\Users\me\AppData\Local\Temp\claude\x.output`}\n- https://x.example.com`,
      ),
    ).toEqual([]);
  });

  it('rejects a status report', () => {
    expect(
      knowledgeFrom('- Agent "Build @husk-ai/models" failed: rate limited\n- https://ci.example.com/3'),
    ).toEqual([]);
  });

  it('rejects a candidate that is mostly markup', () => {
    expect(
      knowledgeFrom('<status>ok</status>\n<summary>a</summary>\n<note>b</note>\n<usage>c</usage>\n- https://x.example.com'),
    ).toEqual([]);
  });

  it('rejects a 5 KB dump rather than clamping it into an elided blob', () => {
    const dump = '- fact line that is long enough to matter here\n'.repeat(120);
    expect(knowledgeFrom(dump)).toEqual([]);
  });

  it('still accepts a genuine durable fact', () => {
    const kept = knowledgeFrom(
      '- api runs on fly.io in iad\n- the worker is a systemd unit on box-3\n- secrets live in 1Password',
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.content).toContain('systemd unit on box-3');
  });

  it('caps what it does keep', () => {
    const kept = knowledgeFrom('- fact number one here\n'.repeat(60) + '- https://x.example.com');
    for (const k of kept) expect(k.content.length).toBeLessThanOrEqual(1400);
  });
});

describe('example selection rejects notifications', () => {
  it('never uses a system notification as the user side of an exemplar', () => {
    const examples = mineExamples([
      {
        role: 'user',
        content:
          '<task-notification>\n<task-id>ada8b7efdd87365b9</task-id>\n<status>failed</status>\n<result>I have everything I need.</result>\n</task-notification>',
      },
      { role: 'assistant', content: 'Acknowledged, the background agent reported a failure and I will retry it now.' },
      { role: 'user', content: 'Please summarise the billing migration plan for the team in two paragraphs.' },
      { role: 'assistant', content: 'Here is the two paragraph summary of the billing migration plan, impact first.' },
    ]);
    expect(examples.every((e) => !e.user.includes('task-notification'))).toBe(true);
    expect(examples.some((e) => /billing migration plan/i.test(e.user))).toBe(true);
  });
});

describe('example de-duplication', () => {
  it('does not offer the same prompt twice', () => {
    const repeated = 'I hit my usage limit while you were working, but it has reset now. Please continue.';
    const examples = mineExamples([
      { role: 'user', content: repeated },
      { role: 'assistant', content: 'Let me check what actually landed before the limit hit and pick it up.' },
      { role: 'user', content: repeated },
      { role: 'assistant', content: 'Let me take a clean snapshot of where everything stands right now.' },
      { role: 'user', content: 'Now summarise the billing migration plan for the team, impact first.' },
      { role: 'assistant', content: 'Here is the summary of the billing migration plan with the impact stated first.' },
    ]);
    const prompts = examples.map((e) => e.user);
    expect(new Set(prompts).size).toBe(prompts.length);
    expect(prompts.some((p) => /billing migration plan/i.test(p))).toBe(true);
  });
});

describe('identity phrasings people actually use', () => {
  const identity = [
    'Think like an experienced SRE and tell me what is wrong here.',
    'think like a founder, CTO and product manager',
    'Approach this as a security reviewer.',
    'Act as a technical editor.',
    'You are a careful code reviewer.',
    'Your role is to triage incoming bugs.',
    'Put on your PM hat and cut the scope.',
    'Pretend to be a sceptical customer.',
    'Assume the role of a release manager.',
  ];
  for (const line of identity) {
    it(`treats as a role instruction: ${line.slice(0, 42)}`, () => {
      const hit = DIRECTIVES.find((d) => d.re.test(line));
      expect(hit, `no directive matched "${line}"`).toBeDefined();
      expect(hit!.kind).toBe('identity');
    });
  }

  // The anchoring exists so ordinary prose does not become a persona opener.
  const notIdentity = [
    'I think like this because the tests pass.',
    'It behaves as expected now.',
    'The hat function returns a string.',
    'Can you explain how the router works?',
  ];
  for (const line of notIdentity) {
    it(`does not treat as a role instruction: ${line.slice(0, 42)}`, () => {
      const hit = DIRECTIVES.find((d) => d.re.test(line) && d.kind === 'identity');
      expect(hit, `"${line}" was wrongly read as a role instruction`).toBeUndefined();
    });
  }
});
