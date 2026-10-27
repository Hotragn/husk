import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ui from '../ui.js';

const destroy = vi.fn(async () => true);
const destroyAll = vi.fn(async () => 1);
// A chat's computer by default; a test can swap in another spec.
let spec: Record<string, unknown> = { persist: true, labels: { 'husk.key': 'chat:1' } };
vi.mock('../lib/computers.js', () => ({
  manager: () => ({ destroy, destroyAll, list: async () => [{ id: 'cmp_1', name: 'bot', lastUsedAt: '2026-01-01T00:00:00Z' }] }),
  resolve: async () => ({ info: { id: 'cmp_1', name: 'bot', workdir: '/work', provider: 'docker', spec } }),
}));
const { run } = await import('./rm.js');

describe('husk rm', () => {
  afterEach(() => {
    vi.clearAllMocks();
    spec = { persist: true, labels: { 'husk.key': 'chat:1' } };
  });

  it('goes through the manager, and keeps what a chat’s computer keeps unless told to erase', async () => {
    const print = vi.spyOn(ui, 'print').mockImplementation(() => {});
    expect(await run(['bot', '--yes'])).toBe(0);
    expect(print.mock.calls.at(-1)?.[0]).toContain('its files stay for its next computer');
    expect(await run(['bot', '--erase', '--yes'])).toBe(0);
    expect(await run(['--all', '--erase', '--yes'])).toBe(0);
    expect(destroy.mock.calls).toEqual([
      ['cmp_1', { erase: false }],
      ['cmp_1', { erase: true }],
    ]);
    expect(destroyAll.mock.calls).toEqual([[{ erase: true }]]);
  });

  it('says nothing stays for a bot’s computer without persist, whose /work is a tmpfs', async () => {
    spec = { labels: { 'husk.key': 'husk:triage' } };
    const print = vi.spyOn(ui, 'print').mockImplementation(() => {});
    expect(await run(['bot', '--yes'])).toBe(0);
    expect(print.mock.calls.at(-1)?.[0]).not.toContain('stay');
  });
});
