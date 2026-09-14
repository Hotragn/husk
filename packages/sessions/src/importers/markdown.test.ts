import { describe, expect, it } from 'vitest';
import { MarkdownImporter, parseMarkdownChat, toMarkdownChat } from './markdown.js';

describe('parseMarkdownChat', () => {
  it('reads ## User / ## Assistant headings', () => {
    const t = parseMarkdownChat(['## User', '', 'hello', '', '## Assistant', '', 'hi there'].join('\n'));
    expect(t?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('reads **Assistant:** bold markers', () => {
    const t = parseMarkdownChat(['**User:** what is 2+2', '', '**Assistant:** four'].join('\n'));
    expect(t?.messages).toEqual([
      { role: 'user', content: 'what is 2+2' },
      { role: 'assistant', content: 'four' },
    ]);
  });

  it('reads bare `User:` prefixes', () => {
    const t = parseMarkdownChat(['User: ship it', 'Assistant: shipping'].join('\n'));
    expect(t?.messages).toEqual([
      { role: 'user', content: 'ship it' },
      { role: 'assistant', content: 'shipping' },
    ]);
  });

  it('treats a leading non-role heading as the title', () => {
    const t = parseMarkdownChat(['# Planning session', '', '## User', 'go', '', '## Assistant', 'ok'].join('\n'));
    expect(t?.title).toBe('Planning session');
    expect(t?.messages).toHaveLength(2);
  });

  it('does not split on a role word inside a fenced code block', () => {
    const src = ['## User', 'run this:', '', '```', 'User: not a marker', 'Assistant: also not', '```'].join('\n');
    const t = parseMarkdownChat(src);
    expect(t?.messages).toHaveLength(1);
    expect(t?.messages[0]?.content).toContain('User: not a marker');
  });

  it('treats text before the first marker as the opening user turn', () => {
    const t = parseMarkdownChat(['just a question', '', '## Assistant', 'an answer'].join('\n'));
    expect(t?.messages[0]).toEqual({ role: 'user', content: 'just a question' });
  });

  it('round-trips a plainly pasted chat', () => {
    const original = parseMarkdownChat(
      ['# Notes', '', 'User: always use tabs', '', 'Assistant: understood', '', 'User: and never spaces'].join('\n'),
    );
    expect(original).toBeDefined();
    const round = parseMarkdownChat(toMarkdownChat(original!));
    expect(round?.title).toBe(original!.title);
    expect(round?.messages).toEqual(original!.messages);
  });

  it('round-trips multi-paragraph and fenced content', () => {
    const t = {
      id: 't',
      source: 'markdown' as const,
      title: 'Fences',
      messages: [
        { role: 'user' as const, content: 'run:\n\n```sh\nls -la\n```' },
        { role: 'assistant' as const, content: 'para one\n\npara two' },
      ],
    };
    const round = parseMarkdownChat(toMarkdownChat(t));
    expect(round?.messages).toEqual(t.messages);
  });

  it('returns undefined for content with no messages', () => {
    expect(parseMarkdownChat('')).toBeUndefined();
  });
});

describe('MarkdownImporter', () => {
  const importer = new MarkdownImporter();

  it('scores a chat-shaped document above a prose one', async () => {
    const chat = await importer.detect({ content: '## User\na\n## Assistant\nb\n## User\nc\n## Assistant\nd' });
    const prose = await importer.detect({ content: '# Title\n\nsome ordinary prose about users.' });
    expect(chat).toBeGreaterThan(prose);
  });

  it('refuses to claim JSON', async () => {
    expect(await importer.detect({ path: 'x.md', content: '[{"mapping":{}}]' })).toBeLessThanOrEqual(0.05);
  });
});
