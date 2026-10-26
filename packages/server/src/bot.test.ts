import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyAgentFactory } from './deps.js';
import { claudeCodeTranscript } from './routes/sessions.js';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

let harness: TestApp | undefined;
let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await harness?.cleanup();
  harness = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('finding a Claude Code chat to make into a bot', () => {
  it('finds the session file in any project', async () => {
    root = await mkdtemp(join(tmpdir(), 'husk-cc-'));
    await mkdir(join(root, 'C--work-app'), { recursive: true });
    const file = join(root, 'C--work-app', '3f2a9c1e-0000-4000-8000-000000000001.jsonl');
    await writeFile(file, '{}\n');
    expect(await claudeCodeTranscript('3f2a9c1e-0000-4000-8000-000000000001', [root])).toBe(file);
    expect(await claudeCodeTranscript('3f2a9c1e-0000-4000-8000-000000000002', [root])).toBeUndefined();
  });

  it('never treats a session id as a path', async () => {
    root = await mkdtemp(join(tmpdir(), 'husk-cc-'));
    expect(await claudeCodeTranscript('../../etc/passwd', [root])).toBeUndefined();
    expect(await claudeCodeTranscript('..', [root])).toBeUndefined();
  });

  it('says plainly when a chat cannot be read back', { timeout: 30_000 }, async () => {
    harness = await buildTestApp();
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    const res = await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/bot`, payload: {} });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.hint).toContain('export the chat');
  });
});

describe('making a bot from a chat file or pasted text', () => {
  const chat = (id: string, title: string, at: number, ask: string) => ({
    title,
    create_time: at,
    update_time: at + 60,
    conversation_id: id,
    current_node: 'a',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['q'] },
      q: { id: 'q', parent: 'root', children: ['a'], message: { id: 'q', author: { role: 'user' }, create_time: at, content: { content_type: 'text', parts: [ask] }, metadata: {} } },
      a: { id: 'a', parent: 'q', children: [], message: { id: 'a', author: { role: 'assistant' }, create_time: at + 10, content: { content_type: 'text', parts: ['Done.'] }, metadata: {} } },
    },
  });

  it('asks which chat when an export holds many, keeps only the one picked, and drafts it on Husk’s engine', { timeout: 30_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'husk-import-'));
    vi.stubEnv('HUSK_CLAUDE_CLI', join(root, 'not-installed'));
    vi.stubEnv('HUSK_CODEX_CLI', join(root, 'not-installed'));
    harness = await buildTestApp();
    const content = JSON.stringify([chat('conv-old', 'Old chat', 1_760_000_000, 'Hello.'), chat('conv-new', 'Weekly report', 1_761_000_000, 'Always send the weekly report on Mondays.')]);
    const listed = (await harness.app.inject({ method: 'POST', url: '/v1/sessions/import', payload: { content } })).json();
    expect(listed.source).toBe('chatgpt');
    expect(listed.choices.map((c: { id: string }) => c.id)).toEqual(['conv-new', 'conv-old']);
    expect(listed.transcript).toBeUndefined();

    const picked = (await harness.app.inject({ method: 'POST', url: '/v1/sessions/import', payload: { content, pick: 'conv-new' } })).json();
    expect(picked.transcript).toMatchObject({ id: 'conv-new', source: 'chatgpt' });
    const draft = (await harness.app.inject({ method: 'POST', url: '/v1/sessions/distill', payload: { transcriptId: 'conv-new' } })).json();
    expect(draft).toMatchObject({ transcriptId: 'conv-new', engines: ['builtin'], spec: { engine: { type: 'builtin' } } });
    expect((await harness.app.inject({ method: 'POST', url: '/v1/sessions/import', payload: { content, pick: 'conv-gone' } })).json().error.code).toBe('E_IMPORT_FAILED');
  });

  it('finds Codex chats where Codex keeps them, titled by what the person asked', { timeout: 30_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'husk-discover-'));
    vi.stubEnv('CODEX_HOME', root);
    const day = join(root, 'sessions', '2026', '10', '25');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, 'rollout-2026-10-25T10-00-00-cccc.jsonl'),
      [
        { timestamp: '2026-10-25T10:00:00.000Z', type: 'session_meta', payload: { id: 'codex-1' } },
        { timestamp: '2026-10-25T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Tidy the release notes every Friday' } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    harness = await buildTestApp();
    const { sessions } = (await harness.app.inject({ method: 'GET', url: '/v1/sessions/discover?source=codex' })).json();
    expect(sessions).toEqual([expect.objectContaining({ source: 'codex', title: 'Tidy the release notes every Friday' })]);
  });
});

describe('making a Claude Code chat a bot', () => {
  const sid = '3f2a9c1e-0000-4000-8000-0000000000aa';
  const line = (type: 'user' | 'assistant', uuid: string, parentUuid: string | null, content: unknown) =>
    JSON.stringify({ parentUuid, isSidechain: false, type, uuid, sessionId: sid, cwd: '/work', timestamp: '2026-10-25T10:00:00.000Z', message: { role: type, content } });

  it("runs on the person's own Claude Code and continues the chat, when it is installed", { timeout: 30_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'husk-cc-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    const project = join(root, '.claude', 'projects', 'C--work');
    await mkdir(project, { recursive: true });
    const transcript = join(project, `${sid}.jsonl`);
    await writeFile(transcript, [line('user', 'u01', null, 'Check the site every morning and tell me if it is down.'), line('assistant', 'a01', 'u01', [{ type: 'text', text: 'The site is up.' }])].join('\n'));
    harness = await buildTestApp();
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: { labels: { 'husk.session': sid } } })).json() as { id: string };
    const draft = async (payload: object) => (await harness!.app.inject({ method: 'POST', url: `/v1/computers/${id}/bot`, payload })).json();

    // Any file that is there: Claude Code is installed, Codex is not.
    vi.stubEnv('HUSK_CLAUDE_CLI', transcript);
    vi.stubEnv('HUSK_CODEX_CLI', join(root, 'not-installed'));
    const mine = await draft({});
    expect(mine).toMatchObject({ engines: ['claude-code', 'builtin'], spec: { model: 'auto', engine: { type: 'claude-code', resume: sid } } });
    expect(mine.yaml).toContain(`resume: ${sid}`);
    expect((await draft({ engine: 'builtin' })).spec.engine).toEqual({ type: 'builtin' });
    // An engine that is not installed is not one it can run on.
    expect((await draft({ engine: 'codex' })).spec.engine).toMatchObject({ type: 'claude-code' });

    vi.stubEnv('HUSK_CLAUDE_CLI', join(root, 'not-installed'));
    expect(await draft({})).toMatchObject({ engines: ['builtin'], spec: { engine: { type: 'builtin' } } });
  });

  it("reads a Codex chat back by the rollout that names its computer, and runs it on the person's Codex", { timeout: 30_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'husk-codex-'));
    vi.stubEnv('CODEX_HOME', root);
    harness = await buildTestApp();
    const { id } = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json() as { id: string };
    const day = join(root, 'sessions', '2026', '10', '25');
    await mkdir(day, { recursive: true });
    const rollout = (session: string, text: string) =>
      [
        { timestamp: '2026-10-25T10:00:00.000Z', type: 'session_meta', payload: { id: session, cwd: '/work', cli_version: '0.147.0' } },
        { timestamp: '2026-10-25T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
        { timestamp: '2026-10-25T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__husk', name: 'shell', arguments: '{"command":"uptime"}', call_id: 'c1' } },
        { timestamp: '2026-10-25T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: `Your computer id is ${text.includes('mine') ? id : 'cmp_other'}.\nup 3 days` } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n');
    await writeFile(join(day, 'rollout-2026-10-25T10-00-00-aaaa.jsonl'), rollout('codex-other', 'Somebody else’s chat'));
    await writeFile(join(day, 'rollout-2026-10-25T10-05-00-bbbb.jsonl'), rollout('codex-mine', 'Check uptime every hour; mine'));
    vi.stubEnv('HUSK_CLAUDE_CLI', join(root, 'not-installed'));
    vi.stubEnv('HUSK_CODEX_CLI', join(day, 'rollout-2026-10-25T10-05-00-bbbb.jsonl'));

    const res = (await harness.app.inject({ method: 'POST', url: `/v1/computers/${id}/bot`, payload: {} })).json();
    expect(res).toMatchObject({ transcriptId: 'codex-mine', engines: ['codex', 'builtin'], spec: { engine: { type: 'codex' } } });
    expect(res.spec.engine.resume).toBeUndefined();
    expect(res.spec.tools).toContain('computer');
  });

  it("runs a bot on the person's Claude Code, as a run of the Husk's own", { timeout: 30_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'husk-cc-'));
    vi.stubEnv('HUSK_HOME', join(root, 'home'));
    // A stand-in for `claude -p`: says what it was asked.
    const stub = join(root, 'claude.mjs');
    await writeFile(
      stub,
      `let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'You asked: ' + input, total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 } }));
});`,
    );
    vi.stubEnv('HUSK_CLAUDE_CLI', stub);
    harness = await buildTestApp({ agent: lazyAgentFactory });
    const spec = { name: 'asker', tools: [], engine: { type: 'claude-code' } };
    expect((await harness.app.inject({ method: 'POST', url: '/v1/husks', payload: { spec } })).statusCode).toBe(201);
    const run = await harness.app.inject({ method: 'POST', url: '/v1/husks/asker/run', payload: { input: 'Is it up?' } });
    expect(run.json()).toMatchObject({ text: 'You asked: Is it up?', stopReason: 'complete', usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.01 } });
    const listed = (await harness.app.inject({ method: 'GET', url: '/v1/runs?husk=asker' })).json() as { runs: Array<{ runId: string; model: string }> };
    expect(listed.runs).toEqual([expect.objectContaining({ runId: run.json().runId, model: 'claude-code' })]);
    const recorded = (await harness.app.inject({ method: 'GET', url: `/v1/runs/${run.json().runId}` })).json();
    expect(JSON.stringify(recorded)).toContain('"type":"usage"');
  });
});
