import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { HuskError, id } from '@husk-ai/core';
import type { ImportInput, Transcript, TranscriptImporter, TranscriptMessage } from '@husk-ai/core';
import { isDirectory, listFiles } from './fsutil.js';

/**
 * Markdown, and specifically the markdown a person produces by pasting a chat
 * into a file. Three spellings are common and all three have to work:
 *
 *   ## User            /  ### Assistant
 *   **Assistant:**     /  **User:**
 *   User:              /  Assistant:
 */

const ROLE_WORDS: Record<string, TranscriptMessage['role']> = {
  user: 'user',
  human: 'user',
  me: 'user',
  you: 'assistant',
  assistant: 'assistant',
  ai: 'assistant',
  bot: 'assistant',
  claude: 'assistant',
  chatgpt: 'assistant',
  gpt: 'assistant',
  model: 'assistant',
  system: 'system',
  tool: 'tool',
  function: 'tool',
};

const ROLE_ALTERNATION = Object.keys(ROLE_WORDS).join('|');

/** `## User`, `### Assistant:`, `#### Tool` */
const HEADING = new RegExp(`^\\s{0,3}#{1,6}\\s+(?:\\*\\*)?(${ROLE_ALTERNATION})(?:\\*\\*)?\\s*:?\\s*$`, 'i');
/** `**Assistant:**`, `__User__:` */
const BOLD = new RegExp(`^\\s{0,3}(?:\\*\\*|__)(${ROLE_ALTERNATION})\\s*:?(?:\\*\\*|__)\\s*:?\\s*(.*)$`, 'i');
/** `User: hello` */
const PLAIN = new RegExp(`^\\s{0,3}(${ROLE_ALTERNATION})\\s*:\\s*(.*)$`, 'i');
/** `# My conversation` -- a heading that is not a role is the title. */
const TITLE = /^\s{0,3}#\s+(.+?)\s*$/;

interface Marker {
  role: TranscriptMessage['role'];
  rest: string;
}

function matchMarker(line: string, insideFence: boolean): Marker | undefined {
  if (insideFence) return undefined;
  const h = HEADING.exec(line);
  if (h) return { role: ROLE_WORDS[(h[1] ?? '').toLowerCase()] ?? 'user', rest: '' };
  const b = BOLD.exec(line);
  if (b) return { role: ROLE_WORDS[(b[1] ?? '').toLowerCase()] ?? 'user', rest: (b[2] ?? '').trim() };
  const p = PLAIN.exec(line);
  if (p) return { role: ROLE_WORDS[(p[1] ?? '').toLowerCase()] ?? 'user', rest: (p[2] ?? '').trim() };
  return undefined;
}

export function parseMarkdownChat(content: string, origin?: string): Transcript | undefined {
  const lines = content.split(/\r?\n/);
  const messages: TranscriptMessage[] = [];
  let title: string | undefined;
  let role: TranscriptMessage['role'] | undefined;
  let buf: string[] = [];
  let fence: string | undefined;

  const flush = () => {
    if (!role) {
      buf = [];
      return;
    }
    const text = buf.join('\n').trim();
    buf = [];
    if (text) messages.push({ role, content: text });
  };

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const token = fenceMatch[1] as string;
      if (!fence) fence = token[0] === '`' ? '`' : '~';
      else if (token[0] === fence) fence = undefined;
      buf.push(line);
      continue;
    }

    const marker = matchMarker(line, fence !== undefined);
    if (marker) {
      flush();
      role = marker.role;
      if (marker.rest) buf.push(marker.rest);
      continue;
    }

    if (!role && title === undefined) {
      const t = TITLE.exec(line);
      if (t) {
        title = (t[1] ?? '').trim();
        continue;
      }
    }
    if (!role) {
      // Text before the first marker is the opening user turn.
      if (line.trim() === '') continue;
      role = 'user';
    }
    buf.push(line);
  }
  flush();

  if (!messages.length) return undefined;

  return {
    id: origin ? basename(origin, extname(origin)) : id('md'),
    source: 'markdown',
    messages,
    ...(title ? { title } : {}),
    ...(origin ? { origin } : {}),
  };
}

const ROLE_HEADING: Record<TranscriptMessage['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
};

/** The inverse of `parseMarkdownChat`. Round-trips through it unchanged. */
export function toMarkdownChat(transcript: Transcript): string {
  const out: string[] = [];
  if (transcript.title) out.push(`# ${transcript.title}`, '');
  for (const m of transcript.messages) {
    out.push(`## ${ROLE_HEADING[m.role]}`, '', m.content.trim(), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export class MarkdownImporter implements TranscriptImporter {
  readonly id = 'markdown' as const;
  readonly displayName = 'Markdown chat';

  async detect(input: { path?: string; content?: string }): Promise<number> {
    try {
      let score = 0;
      const path = input.path?.toLowerCase();
      if (path?.endsWith('.md') || path?.endsWith('.markdown') || path?.endsWith('.txt')) score = 0.3;

      const probe = input.content?.slice(0, 32 * 1024);
      if (probe) {
        const hits = probe
          .split(/\r?\n/)
          .filter((l) => matchMarker(l, false) !== undefined).length;
        if (hits >= 4) score = Math.max(score, 0.85);
        else if (hits >= 2) score = Math.max(score, 0.6);
        else if (hits === 1) score = Math.max(score, 0.25);
        // JSON is never markdown, whatever the extension says.
        if (/^\s*[[{]/.test(probe)) score = Math.min(score, 0.05);
      }
      return score;
    } catch {
      return 0;
    }
  }

  async parse(input: ImportInput): Promise<Transcript[]> {
    if (input.content !== undefined) {
      const t = parseMarkdownChat(input.content, input.path);
      return t ? [t] : [];
    }
    if (!input.path) {
      throw new HuskError('E_IMPORT_FAILED', 'Markdown import needs a path or content.', {
        hint: 'Pass { path } to a .md file, or { content } with the pasted chat.',
      });
    }
    const files = (await isDirectory(input.path)) ? await listFiles(input.path, '.md') : [input.path];
    const out: Transcript[] = [];
    for (const f of files) {
      try {
        const t = parseMarkdownChat(await readFile(f, 'utf8'), f);
        if (t) out.push(t);
      } catch (cause) {
        throw new HuskError('E_IMPORT_FAILED', `Cannot read ${f}.`, {
          hint: 'Check the path exists and is readable.',
          cause,
        });
      }
    }
    return out;
  }
}
