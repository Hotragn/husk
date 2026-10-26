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

    // Any file that is there: Claude Code is installed.
    vi.stubEnv('HUSK_CLAUDE_CLI', transcript);
    const mine = await draft({});
    expect(mine).toMatchObject({ claudeCode: true, spec: { model: 'auto', engine: { type: 'claude-code', resume: sid } } });
    expect(mine.yaml).toContain(`resume: ${sid}`);
    expect((await draft({ engine: 'builtin' })).spec.engine).toEqual({ type: 'builtin' });

    vi.stubEnv('HUSK_CLAUDE_CLI', join(root, 'not-installed'));
    expect(await draft({})).toMatchObject({ claudeCode: false, spec: { engine: { type: 'builtin' } } });
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
