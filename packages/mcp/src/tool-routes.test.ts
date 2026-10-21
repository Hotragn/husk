import { createLogger } from '@husk-ai/core';
import type { Computer, ComputerInfo } from '@husk-ai/core';
import { createApp, Store, summarise } from '@husk-ai/server';
import type { ManagerLike } from '@husk-ai/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolRoutes } from './tool-routes.js';

const info: ComputerInfo = {
  id: 'cmp_chat',
  name: 'mcp-chat',
  provider: 'docker',
  state: 'running',
  image: 'x',
  workdir: '/work',
  createdAt: '2026-10-21T00:00:00Z',
  lastUsedAt: '2026-10-21T00:00:00Z',
  spec: {},
} as ComputerInfo;

const commands: string[] = [];
const computer = {
  id: info.id,
  info,
  refresh: async () => info,
  exec: async (req: { cmd: string | string[] }) => {
    commands.push(String(req.cmd));
    return { exitCode: 0, stdout: 'hello from the shared husk\n', stderr: '', durationMs: 1, timedOut: false };
  },
} as unknown as Computer;

const manager = {
  status: async () => [],
  create: async () => computer,
  get: async (id: string) => (id === info.id ? computer : null),
  list: async () => [info],
  destroy: async () => true,
} as unknown as ManagerLike;

let root: string | undefined;
const home = process.env.HUSK_HOME;
afterEach(async () => {
  if (home === undefined) delete process.env.HUSK_HOME;
  else process.env.HUSK_HOME = home;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function app() {
  root = await mkdtemp(join(tmpdir(), 'husk-tools-'));
  process.env.HUSK_HOME = root;
  return createApp({
    manager,
    router: { chat: async () => { throw new Error('unused'); }, stream: async function* () {} } as never,
    store: new Store(),
    logger: createLogger({ level: 'silent' }),
    config: { host: '127.0.0.1', port: 0, triggers: false, consoleDir: join(root, 'no-console') },
    plugins: [toolRoutes],
  });
}

describe('the shared tool route', { timeout: 30_000 }, () => {
  it('runs a chat tool on its computer, and records it for the console', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/v1/computers/cmp_chat/tools/shell',
      payload: { args: { command: 'echo hi' }, via: 'mcp' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json().content)).toContain('hello from the shared husk');
    expect(commands.at(-1)).toContain('echo hi');

    const activity = (await a.inject({ method: 'GET', url: '/v1/computers/cmp_chat/activity' })).json().entries;
    expect(activity).toEqual([expect.objectContaining({ tool: 'shell', ok: true, via: 'mcp', summary: 'echo hi' })]);

    const overview = (await a.inject({ method: 'GET', url: '/v1/overview' })).json();
    expect(overview.activity.cmp_chat).toMatchObject({ tool: 'shell' });
    await a.close();
  });

  it('never puts typed text in the timeline', () => {
    expect(summarise('browser_type', { ref: 'e3', text: 'hunter2' })).toBeUndefined();
    expect(summarise('write_file', { path: '/work/a.txt', content: 'secret' })).toBe('/work/a.txt');
  });

  it('404s a computer it does not know', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/v1/computers/cmp_nope/tools/shell', payload: { args: { command: 'x' } } });
    expect(res.statusCode).toBe(404);
    await a.close();
  });
});
