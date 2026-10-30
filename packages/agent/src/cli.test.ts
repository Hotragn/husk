import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, parseSpec } from '@husk-ai/core';
import type { HuskSpecInput } from '@husk-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAgent } from './cli.js';
import type { AgentRunEvent } from './types.js';

/**
 * A stand-in for `claude` or `codex`: it writes down how it was started and
 * what it was asked, then prints the lines it was given, or waits to be killed.
 */
const STUB = `
import { readFileSync, writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8').on('data', (d) => (input += d)).on('end', () => {
  writeFileSync(process.env.STUB_RECORD, JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, memoryDir: process.env.HUSK_MEMORY_DIR ?? null }));
  if (process.env.STUB_HANG) return void setInterval(() => {}, 1000);
  for (const line of JSON.parse(readFileSync(process.env.STUB_LINES, 'utf8'))) process.stdout.write(JSON.stringify(line) + '\\n');
  process.stderr.write(process.env.STUB_STDERR ?? '');
  process.exitCode = Number(process.env.STUB_EXIT ?? 0);
});
`;

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'husk-cli-'));
  writeFileSync(join(dir, 'stub.mjs'), STUB);
  vi.stubEnv('HUSK_HOME', join(dir, 'home'));
  vi.stubEnv('HUSK_LAUNCH', JSON.stringify({ command: 'husk-mcp-test', args: ['bin.js'] }));
  vi.stubEnv('HUSK_CLAUDE_CLI', join(dir, 'stub.mjs'));
  vi.stubEnv('HUSK_CODEX_CLI', join(dir, 'stub.mjs'));
  vi.stubEnv('STUB_RECORD', join(dir, 'record.json'));
  vi.stubEnv('STUB_LINES', join(dir, 'lines.json'));
  // The shared Husk may itself have been started from a Claude Code chat.
  vi.stubEnv('CLAUDECODE', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const log = createLogger({ level: 'silent' });
const agent = (spec: Partial<HuskSpecInput>) => new CliAgent({ spec: parseSpec({ name: 'nightly', persona: 'Check the site.', ...spec }), logger: log });
const prints = (lines: unknown[]) => writeFileSync(join(dir, 'lines.json'), JSON.stringify(lines));
const started = () => JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as { argv: string[]; input: string; cwd: string; claudecode: string | null; memoryDir: string | null };
const notesFolder = () => join(dir, 'home', 'bots', 'nightly', 'memory');
const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
async function drain(a: CliAgent, input = 'Is the site up?', signal?: AbortSignal): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const e of a.stream({ input, ...(signal ? { signal } : {}) })) events.push(e);
  return events;
}
const resultOf = (events: AgentRunEvent[]) => (events.at(-1) as Extract<AgentRunEvent, { type: 'run_end' }>).result;

const claudeRun = (extra: unknown[] = []) => [
  { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'husk', status: 'connected' }] },
  { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu1', name: 'mcp__husk__shell', input: { command: 'curl -sI https://example.com' } }] } },
  { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'HTTP/2 200' }], is_error: false }] } },
  // A subagent's message: not the run's own.
  { type: 'assistant', parent_tool_use_id: 'tu9', message: { id: 'sub', content: [{ type: 'text', text: 'from a subagent' }] } },
  ...extra,
  { type: 'result', subtype: 'success', is_error: false, result: 'The site is up.', num_turns: 2, total_cost_usd: 0.0123, usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } },
];

describe('the claude-code engine', () => {
  it("runs the person's Claude Code headless, with Husk's tools and nothing else", async () => {
    prints(claudeRun());
    const events = await drain(agent({ engine: { type: 'claude-code' } }));
    const { argv, input, cwd, claudecode } = started();

    expect(argv.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(after(argv, '--tools')).toBe('');
    expect(argv).toContain('--strict-mcp-config');
    expect(after(argv, '--setting-sources')).toBe('user');
    expect(after(argv, '--allowedTools')).toBe('mcp__husk');
    expect(after(argv, '--permission-mode')).toBe('dontAsk');
    expect(after(argv, '--max-budget-usd')).toBe('0.5');
    expect(after(argv, '--append-system-prompt')).toContain('Check the site.');
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--model');
    // Its own folder, so no project's hooks run; the prompt on stdin, never on a command line.
    // Real paths: on a Mac the temp folder is under /var, which is /private/var.
    expect(realpathSync(cwd)).toBe(realpathSync(join(dir, 'home', 'bots', 'nightly')));
    expect(input).toBe('Is the site up?');
    expect(claudecode).toBeNull();

    const config = JSON.parse(readFileSync(after(argv, '--mcp-config')!, 'utf8'));
    expect(config.mcpServers.husk).toMatchObject({ type: 'stdio', command: 'husk-mcp-test', args: ['bin.js', '--flavor', 'base', '--keep', '--network', 'egress', '--session', 'bot-nightly'] });

    expect(events.map((e) => e.type)).toEqual(['run_start', 'step_start', 'text_delta', 'tool_start', 'tool_end', 'usage', 'run_end']);
    const start = events.find((e) => e.type === 'tool_start') as Extract<AgentRunEvent, { type: 'tool_start' }>;
    expect(start.call).toMatchObject({ name: 'shell', args: { command: 'curl -sI https://example.com' } });
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ output: 'HTTP/2 200', isError: false });
    expect(resultOf(events)).toMatchObject({
      text: 'The site is up.',
      stopReason: 'complete',
      steps: 1,
      usage: { inputTokens: 40, outputTokens: 12, cacheReadTokens: 900, costUsd: 0.0123 },
    });
  });

  it("continues a chat as a fork, on the chat's own computer, and shows no cost that is the chat's", async () => {
    prints(claudeRun());
    const events = await drain(agent({ engine: { type: 'claude-code', resume: 'chat-session-1' }, model: 'sonnet' }));
    const { argv } = started();
    expect(argv.slice(argv.indexOf('--resume'))).toEqual(['--resume', 'chat-session-1', '--fork-session']);
    expect(after(argv, '--model')).toBe('sonnet');
    const config = JSON.parse(readFileSync(after(argv, '--mcp-config')!, 'utf8'));
    expect(config.mcpServers.husk.env).toEqual({ HUSK_BOT: 'nightly', HUSK_CHAT_SESSION: 'chat-session-1' });
    expect(config.mcpServers.husk.args).not.toContain('--session');
    expect(events.some((e) => e.type === 'warning' && /earlier spend/.test(e.message))).toBe(true);
    expect(resultOf(events).usage).toMatchObject({ inputTokens: 40, costUsd: 0 });
  });

  it("starts Husk's MCP server on the browser the husk names", async () => {
    prints(claudeRun());
    await drain(agent({ engine: { type: 'claude-code' }, computer: { browser: 'lightpanda' } }));
    const husk = JSON.parse(readFileSync(after(started().argv, '--mcp-config')!, 'utf8')).mcpServers.husk;
    expect(after(husk.args, '--browser')).toBe('lightpanda');
  });

  it('starts no MCP server for a husk with no tools', async () => {
    prints(claudeRun());
    await drain(agent({ engine: { type: 'claude-code' }, tools: [] }));
    const { argv } = started();
    expect(JSON.parse(readFileSync(after(argv, '--mcp-config')!, 'utf8'))).toEqual({ mcpServers: {} });
    expect(argv).not.toContain('--allowedTools');
    expect(after(argv, '--append-system-prompt')).toContain('You have no tools');
  });

  it("gives a bot that keeps notes its own notes through Husk's tools, and never another bot's", async () => {
    // Left by the bot whose MCP server started the shared Husk this runs in.
    vi.stubEnv('HUSK_MEMORY_DIR', join(dir, 'another-bot'));
    prints(claudeRun());
    await drain(agent({ engine: { type: 'claude-code' }, memory: { enabled: true } }));
    const { argv, memoryDir } = started();
    expect(memoryDir).toBeNull();
    const config = JSON.parse(readFileSync(after(argv, '--mcp-config')!, 'utf8'));
    expect(config.mcpServers.husk.env).toEqual({ HUSK_BOT: 'nightly', HUSK_MEMORY_DIR: notesFolder() });
    expect(after(argv, '--append-system-prompt')).toContain('## Your notes');
  });

  it('gives a bot with no computer that keeps notes its notes alone', async () => {
    prints(claudeRun());
    await drain(agent({ engine: { type: 'claude-code' }, tools: [], memory: { enabled: true } }));
    const { argv } = started();
    const husk = JSON.parse(readFileSync(after(argv, '--mcp-config')!, 'utf8')).mcpServers.husk;
    expect(husk.args).toEqual(['bin.js', '--flavor', 'base']);
    expect(husk.env).toEqual({ HUSK_BOT: 'nightly', HUSK_MEMORY_DIR: notesFolder(), HUSK_MEMORY_ONLY: '1' });
    expect(after(argv, '--allowedTools')).toBe('mcp__husk');
    expect(after(argv, '--append-system-prompt')).toContain('Your only tool is your notes');
  });

  it('says a bot that asks for sqlite notes keeps none', async () => {
    prints(claudeRun());
    const events = await drain(agent({ engine: { type: 'claude-code' }, memory: { enabled: true, backend: 'sqlite' } }));
    expect(events[1]).toEqual({ type: 'warning', message: expect.stringContaining('sqlite is not built yet') });
    expect(after(started().argv, '--append-system-prompt')).not.toContain('## Your notes');
  });

  it("stops when Husk's tools did not start, rather than let the model only talk", async () => {
    prints([{ type: 'system', subtype: 'init', mcp_servers: [{ name: 'husk', status: 'failed' }] }, ...claudeRun().slice(1)]);
    const result = resultOf(await drain(agent({ engine: { type: 'claude-code' } })));
    expect(result.stopReason).toBe('error');
    expect(result.error).toMatchObject({ code: 'E_PROVIDER_UNAVAILABLE', message: expect.stringContaining("Husk's tools did not start") });
  });

  it('says what the CLI said when it stops without a result', async () => {
    prints([]);
    vi.stubEnv('STUB_EXIT', '1');
    vi.stubEnv('STUB_STDERR', 'Invalid API key · Please run /login\n');
    const result = resultOf(await drain(agent({ engine: { type: 'claude-code' } })));
    expect(result.stopReason).toBe('error');
    expect(result.error?.message).toMatch(/Claude Code stopped \(exit 1\) before it finished; it said: Invalid API key/);
  });

  it('reads a budget stop as a budget stop', async () => {
    prints([...claudeRun().slice(0, -1), { type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1.01, usage: {} }]);
    expect(resultOf(await drain(agent({ engine: { type: 'claude-code' } }))).stopReason).toBe('budget');
  });

  it('stops the CLI when the run is cancelled', async () => {
    prints([]);
    vi.stubEnv('STUB_HANG', '1');
    const abort = new AbortController();
    const done = drain(agent({ engine: { type: 'claude-code' } }), 'hi', abort.signal);
    // Cancel once it is running: its record says it got the prompt.
    await vi.waitFor(() => expect(started().input).toBe('hi'), { timeout: 10_000 });
    abort.abort();
    expect(resultOf(await done).stopReason).toBe('aborted');
  }, 30_000);

  it('says how to point Husk at a CLI it cannot find', async () => {
    vi.stubEnv('HUSK_CLAUDE_CLI', join(dir, 'missing'));
    const result = resultOf(await drain(agent({ engine: { type: 'claude-code' } })));
    expect(result.error).toMatchObject({ code: 'E_PROVIDER_UNAVAILABLE', message: expect.stringContaining('HUSK_CLAUDE_CLI') });
  });
});

describe('the codex engine', () => {
  const codexRun = (extra: unknown[] = []) => [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'husk', tool: 'shell', arguments: { command: 'uptime' }, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'husk', tool: 'shell', arguments: { command: 'uptime' }, status: 'completed', result: { content: [{ type: 'text', text: 'up 3 days' }] } } },
    ...extra,
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Up three days.' } },
    { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2 } },
  ];

  it("runs the person's Codex without their config, its own tools off, and Husk's MCP server required", async () => {
    prints(codexRun());
    const events = await drain(agent({ engine: { type: 'codex' } }));
    const { argv, input } = started();
    expect(argv.slice(0, 2)).toEqual(['exec', '--json']);
    for (const flag of ['--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']) expect(argv).toContain(flag);
    expect(after(argv, '--sandbox')).toBe('read-only');
    const set = argv.filter((_, i) => argv[i - 1] === '-c');
    for (const off of ['features.shell_tool=false', 'features.apps=false', 'web_search="disabled"', 'approval_policy="never"', 'mcp_servers.husk.required=true']) expect(set).toContain(off);
    expect(set).toContain('mcp_servers.husk.command="husk-mcp-test"');
    expect(set).toContain('mcp_servers.husk.args=["bin.js","--flavor","base","--keep","--network","egress","--session","bot-nightly"]');
    // Its calls wait out a person's take-over (J5-e).
    expect(set).toContain('mcp_servers.husk.env={HUSK_BOT="nightly"}');
    expect(set.find((s) => s.startsWith('developer_instructions='))).toContain('Check the site.');
    expect(argv.at(-1)).toBe('-');
    expect(input).toBe('Is the site up?');

    expect(events.map((e) => e.type)).toEqual(['run_start', 'step_start', 'tool_start', 'tool_end', 'text_delta', 'usage', 'run_end']);
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ call: { name: 'shell' }, output: 'up 3 days', isError: false });
    expect(resultOf(events)).toMatchObject({ text: 'Up three days.', stopReason: 'complete', usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 10 } });
  });

  it('gives a Codex bot that keeps notes its notes as well', async () => {
    prints(codexRun());
    await drain(agent({ engine: { type: 'codex' }, memory: { enabled: true } }));
    const { argv } = started();
    const set = argv.filter((_, i) => argv[i - 1] === '-c');
    expect(set).toContain(`mcp_servers.husk.env={HUSK_BOT="nightly",HUSK_MEMORY_DIR=${JSON.stringify(notesFolder())}}`);
    expect(set.find((s) => s.startsWith('developer_instructions='))).toContain('## Your notes');
  });

  it('stops a run in which Codex acted on its own, outside Husk', async () => {
    prints(codexRun([{ type: 'item.started', item: { id: 'i3', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } }]));
    const result = resultOf(await drain(agent({ engine: { type: 'codex' } })));
    expect(result.stopReason).toBe('error');
    expect(result.error).toMatchObject({ code: 'E_EXEC_DENIED', message: expect.stringContaining('command_execution') });
  });

  it('reads a failed turn as a failed run', async () => {
    prints([{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' }, { type: 'turn.failed', error: { message: 'usage limit reached' } }]);
    const result = resultOf(await drain(agent({ engine: { type: 'codex' } })));
    expect(result).toMatchObject({ stopReason: 'error', error: { message: 'Codex: usage limit reached' } });
  });
});
