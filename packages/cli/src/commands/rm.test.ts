import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ui from '../ui.js';

const destroy = vi.fn(async () => true);
const destroyAll = vi.fn(async () => 1);
vi.mock('../lib/computers.js', () => ({
  manager: () => ({ destroy, destroyAll, list: async () => [{ id: 'cmp_1', name: 'bot', lastUsedAt: '2026-01-01T00:00:00Z' }] }),
  resolve: async () => ({ info: { id: 'cmp_1', name: 'bot', workdir: '/work', provider: 'docker', spec: { labels: { 'husk.key': 'chat:1' } } } }),
}));
const { run } = await import('./rm.js');

describe('husk rm', () => {
  afterEach(() => vi.clearAllMocks());

  it('goes through the manager, and keeps what a chat’s computer keeps unless told to erase', async () => {
    vi.spyOn(ui, 'print').mockImplementation(() => {});
    expect(await run(['bot', '--yes'])).toBe(0);
    expect(await run(['bot', '--erase', '--yes'])).toBe(0);
    expect(await run(['--all', '--erase', '--yes'])).toBe(0);
    expect(destroy.mock.calls).toEqual([
      ['cmp_1', { erase: false }],
      ['cmp_1', { erase: true }],
    ]);
    expect(destroyAll.mock.calls).toEqual([[{ erase: true }]]);
  });
});
