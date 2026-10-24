import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeTranscript } from './routes/sessions.js';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

let harness: TestApp | undefined;
let root: string | undefined;
afterEach(async () => {
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
