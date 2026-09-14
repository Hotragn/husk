import { describe, expect, it } from 'vitest';
import { ChatGPTImporter } from './chatgpt.js';

/** Shaped like a real conversations.json entry, including a regenerated branch. */
const EXPORT = [
  {
    title: 'Refactor the parser',
    create_time: 1_760_000_000,
    update_time: 1_760_003_600,
    conversation_id: 'conv-1',
    current_node: 'n4',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['n1'] },
      n1: {
        id: 'n1',
        parent: 'root',
        children: ['n2', 'n3'],
        message: {
          id: 'n1',
          author: { role: 'user', name: null },
          create_time: 1_760_000_010,
          content: { content_type: 'text', parts: ['Always keep functions under 40 lines.'] },
          metadata: {},
        },
      },
      // Regenerated and discarded.
      n2: {
        id: 'n2',
        parent: 'n1',
        children: [],
        message: {
          id: 'n2',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['DISCARDED REGENERATION'] },
          metadata: {},
        },
      },
      n3: {
        id: 'n3',
        parent: 'n1',
        children: ['n4'],
        message: {
          id: 'n3',
          author: { role: 'assistant' },
          create_time: 1_760_000_020,
          content: { content_type: 'text', parts: ['Understood. I will split anything longer.'] },
          metadata: {},
        },
      },
      n4: {
        id: 'n4',
        parent: 'n3',
        children: [],
        message: {
          id: 'n4',
          author: { role: 'user' },
          content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer' }, 'And here is the file.'] },
          metadata: {},
        },
      },
      hidden: {
        id: 'hidden',
        parent: 'n1',
        children: [],
        message: {
          id: 'hidden',
          author: { role: 'system' },
          content: { content_type: 'text', parts: ['hidden system preamble'] },
          metadata: { is_visually_hidden_from_conversation: true },
        },
      },
    },
  },
];

describe('ChatGPTImporter', () => {
  const importer = new ChatGPTImporter();
  const content = JSON.stringify(EXPORT);

  it('detects a conversations.json by content', async () => {
    expect(await importer.detect({ content })).toBeGreaterThan(0.9);
  });

  it('walks current_node to the root and ignores discarded branches', async () => {
    const [t] = await importer.parse({ content });
    expect(t?.messages.map((m) => m.content)).toEqual([
      'Always keep functions under 40 lines.',
      'Understood. I will split anything longer.',
      '[image]\nAnd here is the file.',
    ]);
  });

  it('drops messages the UI hides', async () => {
    const [t] = await importer.parse({ content });
    expect(t?.messages.some((m) => m.content.includes('hidden system preamble'))).toBe(false);
  });

  it('carries title and timestamps', async () => {
    const [t] = await importer.parse({ content, path: '/x/conversations.json' });
    expect(t?.title).toBe('Refactor the parser');
    expect(t?.id).toBe('conv-1');
    expect(t?.createdAt).toBe(new Date(1_760_000_000_000).toISOString());
    expect(t?.origin).toBe('/x/conversations.json');
  });

  it('falls back to the deepest leaf when current_node is missing', async () => {
    const withoutCurrent = JSON.parse(content) as Array<Record<string, unknown>>;
    delete withoutCurrent[0]!.current_node;
    const [t] = await importer.parse({ content: JSON.stringify(withoutCurrent) });
    expect(t?.messages.at(-1)?.content).toContain('And here is the file.');
  });

  it('throws an actionable error on malformed JSON', async () => {
    await expect(importer.parse({ content: '{not json' })).rejects.toMatchObject({ code: 'E_IMPORT_FAILED' });
  });

  it('returns nothing for JSON that is not an export', async () => {
    await expect(importer.parse({ content: '[{"a":1}]' })).resolves.toEqual([]);
  });
});
