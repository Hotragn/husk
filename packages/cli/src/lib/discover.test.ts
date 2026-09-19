import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover, prettyTitle } from './discover.js';

/**
 * Discovery run from a repository root used to offer every Markdown doc as
 * an importable transcript. Only chat-shaped Markdown belongs in the list;
 * anything else is explicitly imported by path.
 */

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function cwd(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'husk-discover-'));
  return dir;
}

const CHAT = `# My conversation

## User

how do I reverse a list in python?

## Assistant

Use a slice: \`xs[::-1]\`.
`;

describe('discover', () => {
  it('offers markdown that is actually a pasted chat', async () => {
    const cwdPath = await cwd();
    await writeFile(join(cwdPath, 'chat.md'), CHAT);
    const found = await discover({ cwd: cwdPath, source: 'markdown' });
    expect(found.map((c) => c.path)).toEqual([join(cwdPath, 'chat.md')]);
  });

  it('does not offer ordinary repository docs as transcripts', async () => {
    const cwdPath = await cwd();
    await writeFile(join(cwdPath, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n\n- added things\n');
    await writeFile(join(cwdPath, 'README.md'), '# Project\n\nSome prose about the project.\n');
    const found = await discover({ cwd: cwdPath, source: 'markdown' });
    expect(found).toEqual([]);
  });

  it('still finds explicit transcript files next to the docs', async () => {
    const cwdPath = await cwd();
    await writeFile(join(cwdPath, 'README.md'), '# Project\n\nProse.\n');
    await writeFile(join(cwdPath, 'session.md'), CHAT);
    const found = await discover({ cwd: cwdPath, source: 'markdown' });
    expect(found.map((c) => c.path)).toEqual([join(cwdPath, 'session.md')]);
  });
});

describe('prettyTitle', () => {
  it('uses the cwd recorded after an initial metadata line', async () => {
    const cwdPath = await cwd();
    const project = join(cwdPath, 'C--Users-dev-Claude-Code-husk');
    const transcript = join(project, '01234567-89ab-cdef-0123-456789abcdef.jsonl');
    await mkdir(project);
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: 'queue-operation', operation: 'dequeue' }),
        JSON.stringify({ type: 'user', uuid: '1', cwd: 'C:\\Users\\dev\\Claude-Code\\husk' }),
      ].join('\n'),
    );

    await expect(prettyTitle(transcript, 'claude-code')).resolves.toBe(
      'C:\\Users\\dev\\Claude-Code\\husk  01234567',
    );
  });

  it('does not invent path separators when a transcript has no cwd', async () => {
    const cwdPath = await cwd();
    const project = join(cwdPath, 'C--Users-dev-Claude-Code-husk');
    const transcript = join(project, '01234567-89ab-cdef-0123-456789abcdef.jsonl');
    await mkdir(project);
    await writeFile(transcript, JSON.stringify({ type: 'queue-operation', operation: 'dequeue' }));

    await expect(prettyTitle(transcript, 'claude-code')).resolves.toBe(
      'C--Users-dev-Claude-Code-husk  01234567',
    );
  });

  it('finds cwd after a malformed line and ignores an empty cwd', async () => {
    const cwdPath = await cwd();
    const project = join(cwdPath, '-Users-dev-my-project');
    const transcript = join(project, 'abcdef01-session.jsonl');
    await mkdir(project);
    await writeFile(
      transcript,
      [
        '{not json}',
        JSON.stringify({ type: 'queue-operation', cwd: '' }),
        JSON.stringify({ type: 'user', uuid: '1', cwd: '/Users/dev/my-project' }),
      ].join('\n'),
    );

    await expect(prettyTitle(transcript, 'claude-code')).resolves.toBe(
      '/Users/dev/my-project  abcdef01',
    );
  });

  it('keeps discovery reads bounded when cwd is beyond the prefix', async () => {
    const cwdPath = await cwd();
    const project = join(cwdPath, '-Users-dev-large-project');
    const transcript = join(project, 'abcdef01-session.jsonl');
    await mkdir(project);
    await writeFile(
      transcript,
      `${JSON.stringify({ type: 'metadata', padding: 'x'.repeat(33 * 1024) })}\n${JSON.stringify({ cwd: '/Users/dev/large-project' })}`,
    );

    await expect(prettyTitle(transcript, 'claude-code')).resolves.toBe(
      '-Users-dev-large-project  abcdef01',
    );
  });

  it('does not read or alter titles from another source', async () => {
    await expect(prettyTitle('chat-with-dashes.json', 'chatgpt')).resolves.toBe(
      'chat-with-dashes.json',
    );
  });
});
