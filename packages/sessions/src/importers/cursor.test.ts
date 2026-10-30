import { describe, expect, it } from 'vitest';
import { CursorImporter } from './cursor.js';

/** A Cursor chat as its composer stores it: `type: 1` is the person, `type: 2` the assistant. */
const COMPOSER = {
  composerId: 'composer-1',
  name: 'Fix the flaky build',
  conversation: [
    { type: 1, text: 'Why does the build fail on CI only?', timestamp: 1_761_000_000_000 },
    { type: 2, text: 'The test reads a file the runner does not have.' },
    { type: 2, text: 'npm test', toolFormerData: { name: 'run_terminal_command' } },
    { type: 1, text: 'Always run the tests before you push.' },
    { type: 2, text: '' },
  ],
};

const importer = new CursorImporter();

describe('CursorImporter', () => {
  it('reads a chat export: who said what, its tool calls, its name', async () => {
    const [t] = await importer.parse({ content: JSON.stringify(COMPOSER), path: '/x/chat.json' });
    expect(t).toMatchObject({ id: 'composer-1', source: 'cursor', title: 'Fix the flaky build', origin: '/x/chat.json' });
    expect(t!.messages.map((m) => [m.role, m.toolName ?? '', m.content])).toEqual([
      ['user', '', 'Why does the build fail on CI only?'],
      ['assistant', '', 'The test reads a file the runner does not have.'],
      ['tool', 'run_terminal_command', 'npm test'],
      ['user', '', 'Always run the tests before you push.'],
    ]);
    expect(t!.messages[0]!.ts).toBe(new Date(1_761_000_000_000).toISOString());
  });

  it('finds every chat in an export that holds several, and skips what is not one', async () => {
    const other = { ...COMPOSER, composerId: 'composer-2', name: 'Another' };
    const lonely = { composerId: 'composer-3', conversation: [{ type: 1, text: 'Just one message.' }] };
    const found = await importer.parse({ content: JSON.stringify({ allComposers: [COMPOSER, other, lonely] }) });
    expect(found.map((t) => t.id)).toEqual(['composer-1', 'composer-2']);
  });

  it("recovers whole chats from state.vscdb's text, and never half a chat", async () => {
    const whole = JSON.stringify(COMPOSER);
    const cut = JSON.stringify({ ...COMPOSER, composerId: 'composer-cut' }).slice(0, 120);
    const vscdb = `SQLite format 3\u0000\u0004\u0001${'\u0000'.repeat(64)}composerData:1${whole}\u0000\u0013${cut}\u0000\u0000`;
    const found = await importer.parse({ content: vscdb, path: '/x/globalStorage/state.vscdb' });
    expect(found.map((t) => t.id)).toEqual(['composer-1']);
  });

  it('knows its own files', async () => {
    expect(await importer.detect({ path: '/home/me/.config/Cursor/User/globalStorage/state.vscdb' })).toBeGreaterThan(0.8);
    expect(await importer.detect({ content: JSON.stringify(COMPOSER) })).toBeGreaterThan(0.5);
    expect(await importer.detect({ content: '{"title":"a ChatGPT export","mapping":{}}' })).toBe(0);
  });
});
