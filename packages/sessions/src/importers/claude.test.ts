import { describe, expect, it } from 'vitest';
import { ClaudeCodeImporter, parseClaudeJsonl } from './claude.js';

/**
 * Fixtures use the real line shapes, measured from
 * ~/.claude/projects/<project>/<sessionId>.jsonl. If Claude Code changes the
 * format these break, which is the point.
 */

const SESSION = 'b3a1b66c-da72-4ba3-af79-882df990fc62';

const common = {
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  cwd: 'C:\\Users\\dev\\proj',
  sessionId: SESSION,
  version: '2.1.246',
  gitBranch: 'main',
  slug: 'wild-jingling-conway',
};

function userLine(uuid: string, parentUuid: string | null, content: unknown, extra: object = {}) {
  return {
    parentUuid,
    promptId: 'p1',
    type: 'user',
    message: { role: 'user', content },
    uuid,
    timestamp: `2026-08-22T06:${uuid.slice(-2)}:00.000Z`,
    permissionMode: 'auto',
    origin: { kind: 'human' },
    promptSource: 'typed',
    ...common,
    ...extra,
  };
}

function toolResultLine(uuid: string, parentUuid: string, toolUseId: string, body: unknown, isError = false) {
  const line = userLine(uuid, parentUuid, [
    { type: 'tool_result', content: body, tool_use_id: toolUseId, ...(isError ? { is_error: true } : {}) },
  ]);
  // A tool result is not something a human typed.
  const { promptSource: _p, origin: _o, ...rest } = line as Record<string, unknown>;
  return rest;
}

function assistantLine(uuid: string, parentUuid: string, content: unknown[]) {
  return {
    parentUuid,
    message: { model: 'claude-opus-5', id: `msg_${uuid}`, type: 'message', role: 'assistant', content },
    requestId: `req_${uuid}`,
    type: 'assistant',
    uuid,
    timestamp: `2026-08-22T06:${uuid.slice(-2)}:30.000Z`,
    effort: 'high',
    ...common,
  };
}

const LINES: unknown[] = [
  { type: 'mode', mode: 'default', sessionId: SESSION },
  { type: 'permission-mode', permissionMode: 'auto', sessionId: SESSION },
  { type: 'ai-title', aiTitle: 'Audit the build pipeline', sessionId: SESSION },
  { type: 'last-prompt', lastPrompt: 'and now?', leafUuid: 'a04', sessionId: SESSION },

  userLine('u01', null, 'Always run the tests before you claim something works.'),
  assistantLine('a01', 'u01', [
    { type: 'thinking', thinking: 'internal', signature: 'sig' },
    { type: 'text', text: 'Understood. Checking the suite now.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
  ]),
  toolResultLine('r01', 'a01', 'toolu_1', '12 passing'),

  // Abandoned retry branch: same parent as a02b, shorter chain.
  assistantLine('a02', 'r01', [{ type: 'text', text: 'RETRY BRANCH THAT WAS ABANDONED' }]),

  assistantLine('a02b', 'r01', [
    { type: 'text', text: 'Suite is green.' },
    { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/work/build.ts' } },
  ]),
  toolResultLine('r02', 'a02b', 'toolu_2', [{ type: 'text', text: 'export const build = 1;' }]),

  // Injected, not spoken.
  { ...userLine('m01', 'r02', '[Image: original 4032x3024, displayed at 2000x1500.]'), isMeta: true, turnCompanion: true },
  {
    parentUuid: 'm01',
    attachment: { type: 'deferred_tools_delta', addedNames: ['WebFetch'] },
    type: 'attachment',
    uuid: 'at01',
    timestamp: '2026-08-22T06:20:00.000Z',
    ...common,
  },
  assistantLine('a03', 'at01', [{ type: 'text', text: 'Build entry point looks fine.' }]),

  userLine('u02', 'a03', [
    { type: 'text', text: 'Never touch the release branch.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
  ]),
  assistantLine('a04', 'u02', [{ type: 'text', text: 'Noted, release is off limits.' }]),

  // Subagent traffic: excluded from the thread, its tool names are not.
  {
    parentUuid: null,
    agentId: 'a458fe314ceeb9843',
    promptId: 'sc1',
    type: 'user',
    message: { role: 'user', content: 'Research the release policy.' },
    uuid: 's01',
    timestamp: '2026-08-22T06:25:00.000Z',
    ...common,
    isSidechain: true,
  },
  {
    parentUuid: 's01',
    message: {
      model: 'claude-opus-5',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_sc', name: 'WebSearch', input: { query: 'release policy' } }],
    },
    type: 'assistant',
    uuid: 's02',
    timestamp: '2026-08-22T06:25:30.000Z',
    ...common,
    isSidechain: true,
  },
];

const JSONL = LINES.map((l) => JSON.stringify(l)).join('\n');
/** Claude Code is still appending. The last line is half written. */
const TRUNCATED = `${JSONL}\n{"parentUuid":"a04","isSidechain":false,"type":"assistant","message":{"role":"assist`;

describe('parseClaudeJsonl', () => {
  it('extracts messages from real line shapes (the bug: it used to find zero)', () => {
    const parsed = parseClaudeJsonl(JSONL, '/tmp/x.jsonl');
    expect(parsed).toBeDefined();
    expect(parsed!.transcript.messages.length).toBeGreaterThan(0);
  });

  it('uses aiTitle as the transcript title', () => {
    expect(parseClaudeJsonl(JSONL)!.transcript.title).toBe('Audit the build pipeline');
  });

  it('prefers a customTitle over the generated one', () => {
    const withCustom = `${JSON.stringify({ type: 'custom-title', customTitle: 'My audit', sessionId: SESSION })}\n${JSONL}`;
    expect(parseClaudeJsonl(withCustom)!.transcript.title).toBe('My audit');
  });

  it('walks parentUuid from the last leaf and drops abandoned retry branches', () => {
    const { transcript, stats } = parseClaudeJsonl(JSONL)!;
    const all = transcript.messages.map((m) => m.content).join('\n');
    expect(all).not.toContain('RETRY BRANCH THAT WAS ABANDONED');
    expect(all).toContain('Noted, release is off limits.');
    expect(stats.branchesDropped).toBe(1);
  });

  it('pairs tool_use with tool_result and keeps the tool name on both', () => {
    const { transcript } = parseClaudeJsonl(JSONL)!;
    const call = transcript.messages.find((m) => m.role === 'assistant' && m.toolName === 'Bash');
    expect(call?.toolInput).toEqual({ command: 'npm test' });
    expect(call?.meta?.toolUseId).toBe('toolu_1');

    const result = transcript.messages.find((m) => m.role === 'tool' && m.meta?.toolUseId === 'toolu_1');
    expect(result?.toolName).toBe('Bash');
    expect(result?.content).toBe('12 passing');

    // Every tool result resolved to a name.
    const results = transcript.messages.filter((m) => m.role === 'tool');
    expect(results.length).toBe(2);
    expect(results.every((r) => typeof r.toolName === 'string')).toBe(true);
  });

  it('keeps sidechain turns out of the thread but keeps their tool names', () => {
    const { transcript, stats } = parseClaudeJsonl(JSONL)!;
    expect(transcript.messages.map((m) => m.content).join()).not.toContain('Research the release policy');
    expect(transcript.meta?.sidechainTools).toEqual(['WebSearch']);
    expect(transcript.meta?.tools).toEqual(['Bash', 'Read']);
    expect(stats.sidechainLines).toBe(2);
  });

  it('survives a truncated final line without throwing or losing the rest', () => {
    const full = parseClaudeJsonl(JSONL)!;
    const cut = parseClaudeJsonl(TRUNCATED)!;
    expect(cut.stats.truncatedTail).toBe(true);
    expect(cut.stats.unparseable).toBe(0);
    expect(cut.transcript.messages.length).toBe(full.transcript.messages.length);
  });

  it('counts genuinely broken lines separately from a truncated tail', () => {
    const broken = `{"type":"user","uuid":"x"\n${JSONL}`;
    const parsed = parseClaudeJsonl(broken)!;
    expect(parsed.stats.unparseable).toBe(1);
    expect(parsed.stats.truncatedTail).toBe(false);
  });

  it('drops thinking blocks but records that they were there', () => {
    const { transcript } = parseClaudeJsonl(JSONL)!;
    const first = transcript.messages.find((m) => m.content === 'Understood. Checking the suite now.');
    expect(first?.meta?.thinkingBlocks).toBe(1);
    expect(transcript.messages.some((m) => m.content.includes('internal'))).toBe(false);
  });

  it('renders image parts as a placeholder instead of choking', () => {
    const { transcript } = parseClaudeJsonl(JSONL)!;
    const withImage = transcript.messages.find((m) => m.content.includes('Never touch the release branch'));
    expect(withImage?.content).toContain('[image: image/png]');
  });

  it('skips isMeta turns, which are injected rather than typed', () => {
    const { transcript } = parseClaudeJsonl(JSONL)!;
    expect(transcript.messages.some((m) => m.content.startsWith('[Image: original'))).toBe(false);
  });

  it('marks turns a human actually submitted', () => {
    const { transcript } = parseClaudeJsonl(JSONL)!;
    const typed = transcript.messages.filter((m) => m.meta?.promptSource === 'typed');
    expect(typed.map((m) => m.content)).toEqual([
      'Always run the tests before you claim something works.',
      'Never touch the release branch.\n\n[image: image/png]',
    ]);
  });

  it('carries session provenance', () => {
    const { transcript } = parseClaudeJsonl(JSONL, '/p/x.jsonl')!;
    expect(transcript.id).toBe(SESSION);
    expect(transcript.source).toBe('claude-code');
    expect(transcript.origin).toBe('/p/x.jsonl');
    expect(transcript.meta?.model).toBe('claude-opus-5');
    expect(transcript.meta?.gitBranch).toBe('main');
  });

  it('returns undefined for an empty document rather than throwing', () => {
    expect(parseClaudeJsonl('')).toBeUndefined();
    expect(parseClaudeJsonl('\n\n')).toBeUndefined();
  });

  it('does not throw on a file of unrelated JSON', () => {
    const parsed = parseClaudeJsonl('{"hello":"world"}\n{"a":1}');
    expect(parsed?.transcript.messages).toEqual([]);
  });
});

describe('ClaudeCodeImporter', () => {
  const importer = new ClaudeCodeImporter();

  it('detects the format from content, not from the filename', async () => {
    expect(await importer.detect({ content: JSONL })).toBeGreaterThan(0.9);
    expect(await importer.detect({ content: '{"role":"user","content":"hi"}' })).toBeLessThan(0.5);
  });

  it('scores a path under the Claude projects directory', async () => {
    expect(await importer.detect({ path: '/home/x/.claude/projects/p/s.jsonl' })).toBeGreaterThanOrEqual(0.7);
  });

  it('never throws from detect', async () => {
    await expect(importer.detect({ content: '\u0000\u0000' })).resolves.toBeTypeOf('number');
  });

  it('parses from content', async () => {
    const [t] = await importer.parse({ content: JSONL });
    expect(t?.messages.length).toBeGreaterThan(4);
  });

  it('points defaultLocations at the Claude projects directory for this OS', () => {
    const locations = importer.defaultLocations();
    expect(locations.length).toBeGreaterThan(0);
    for (const l of locations) expect(l.replace(/\\/g, '/')).toMatch(/\/projects$/);
    expect(locations[0]?.replace(/\\/g, '/')).toContain('/.claude/projects');
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude';
    try {
      expect(new ClaudeCodeImporter().defaultLocations()[0]?.replace(/\\/g, '/')).toBe('/custom/claude/projects');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it('throws an actionable HuskError with neither path nor content', async () => {
    await expect(importer.parse({})).rejects.toMatchObject({ code: 'E_IMPORT_FAILED' });
  });
});


