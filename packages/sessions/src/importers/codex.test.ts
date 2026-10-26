import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observedTools } from '../distill.js';
import { CodexImporter, codexSessions, parseCodexRollout } from './codex.js';
import { detectAndParse } from './index.js';

const SESSION = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const at = (s: number) => `2026-10-20T09:00:${String(s).padStart(2, '0')}.000Z`;
const item = (s: number, payload: object) => ({ timestamp: at(s), type: 'response_item', payload });
const said = (s: number, role: string, text: string) => item(s, { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });

/** A rollout as Codex writes it (codex-rs history/rollout_payload.rs): its own context first, then the chat. */
const LINES: unknown[] = [
  { timestamp: at(0), type: 'session_meta', payload: { id: SESSION, timestamp: at(0), cwd: '/home/me/app', originator: 'codex_cli_rs', cli_version: '0.147.0', source: 'cli' } },
  said(1, 'developer', '<permissions instructions>\nApprovals are on request.\n</permissions instructions>'),
  said(2, 'user', '# AGENTS.md instructions for /home/me/app\n\nUse pnpm.'),
  said(3, 'user', '<environment_context>\n  <cwd>/home/me/app</cwd>\n</environment_context>'),
  { timestamp: at(4), type: 'turn_context', payload: { cwd: '/home/me/app', approval_policy: 'on-request', model: 'gpt-5.1-codex' } },
  said(5, 'user', 'Check the status page every morning. Never restart prod.'),
  { timestamp: at(5), type: 'event_msg', payload: { type: 'user_message', message: 'Check the status page every morning. Never restart prod.' } },
  item(6, { type: 'reasoning', summary: [], encrypted_content: 'gAAAA' }),
  // Husk's tool, as Codex names an MCP tool now (a namespace) and before (one name).
  item(7, { type: 'function_call', namespace: 'mcp__husk', name: 'browser_goto', arguments: '{"url":"https://status.example.com"}', call_id: 'call_1' }),
  item(8, { type: 'function_call_output', call_id: 'call_1', output: 'Loaded: All systems operational' }),
  item(9, { type: 'function_call', name: 'mcp__husk__shell', arguments: '{"command":"uptime"}', call_id: 'call_2' }),
  item(10, { type: 'function_call_output', call_id: 'call_2', output: { content: 'up 3 days', success: true } }),
  said(11, 'assistant', 'All systems operational; nothing restarted.'),
  { timestamp: at(11), type: 'event_msg', payload: { type: 'agent_message', message: 'All systems operational; nothing restarted.' } },
  { timestamp: at(12), type: 'event_msg', payload: { type: 'token_count', info: null } },
];
const JSONL = LINES.map((l) => JSON.stringify(l)).join('\n');

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('parseCodexRollout', () => {
  it("keeps the person's chat and leaves out Codex's own context", () => {
    const [t] = parseCodexRollout(JSONL, '/x/rollout-2026-10-20T09-00-00-0199a213.jsonl');
    expect(t).toMatchObject({ id: SESSION, source: 'codex', title: 'Check the status page every morning. Never restart prod.', createdAt: at(5), updatedAt: at(11) });
    expect(t!.meta).toMatchObject({ cwd: '/home/me/app', codexVersion: '0.147.0', model: 'gpt-5.1-codex' });
    const said = t!.messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.toolName)).map((m) => m.content);
    expect(said).toEqual(['Check the status page every morning. Never restart prod.', 'All systems operational; nothing restarted.']);
    expect(JSON.stringify(t)).not.toMatch(/AGENTS\.md|environment_context|permissions instructions|gAAAA/);
  });

  it('pairs tool calls with their output, under one name whichever way Codex wrote it', () => {
    const [t] = parseCodexRollout(JSONL);
    const tools = t!.messages.filter((m) => m.toolName);
    expect(tools.map((m) => [m.role, m.toolName])).toEqual([
      ['assistant', 'mcp__husk__browser_goto'],
      ['tool', 'mcp__husk__browser_goto'],
      ['assistant', 'mcp__husk__shell'],
      ['tool', 'mcp__husk__shell'],
    ]);
    expect(tools[0]!.toolInput).toEqual({ url: 'https://status.example.com' });
    expect(tools[3]!.content).toBe('up 3 days');
    // So a bot made from it gets the computer and the browser.
    expect(observedTools(t!)).toMatchObject({ suggested: ['computer', 'web'], needsComputer: true });
  });

  it("uses the UI's copy of the chat when a rollout has no model messages", () => {
    const events = LINES.filter((l) => (l as { type: string }).type !== 'response_item');
    const [t] = parseCodexRollout(events.map((l) => JSON.stringify(l)).join('\n'));
    expect(t!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('skips a half-written last line, and says so plainly for a file that is not a rollout', () => {
    expect(parseCodexRollout(`${JSONL}\n{"timestamp":"x","type":"response_it`)[0]!.messages.length).toBeGreaterThan(0);
    expect(() => parseCodexRollout('{"hello": "world"}')).toThrow(/not a Codex session/);
  });
});

describe('CodexImporter', () => {
  it('is picked for a rollout over the other importers', async () => {
    const result = await detectAndParse({ content: JSONL });
    expect(result.source).toBe('codex');
    expect(result.transcripts[0]!.id).toBe(SESSION);
  });

  it('reads every rollout under a sessions folder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'husk-codex-'));
    mkdirSync(join(dir, '2026', '10', '20'), { recursive: true });
    writeFileSync(join(dir, '2026', '10', '20', `rollout-2026-10-20T09-00-00-${SESSION}.jsonl`), JSONL);
    writeFileSync(join(dir, 'notes.txt'), 'not a rollout');
    const transcripts = await new CodexImporter().parse({ path: dir });
    expect(transcripts.map((t) => t.id)).toEqual([SESSION]);
  });

  it('looks where Codex keeps its sessions, CODEX_HOME included', () => {
    expect(codexSessions({ CODEX_HOME: '/opt/codex' })).toBe(join('/opt/codex', 'sessions'));
    expect(codexSessions({})).toMatch(/\.codex[\\/]sessions$/);
  });
});
