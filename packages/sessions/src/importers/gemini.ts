import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { HuskError, id } from '@husk/core';
import type { ImportInput, Transcript, TranscriptImporter, TranscriptMessage } from '@husk/core';
import { isDirectory, listFiles } from './fsutil.js';

/**
 * Gemini, in the three shapes it actually ships in:
 *
 *  1. Gemini CLI checkpoints -- `{ messages: [{ role, parts: [{ text }] }] }`,
 *     the raw `generateContent` shape, also spelled `contents`.
 *  2. Google Takeout "My Activity" -- `[{ header, title, time, ... }]` where the
 *     prompt is in `title` and the answer is in an html blob.
 *  3. Ad-hoc exports keyed by `message_list` / `conversation_id`.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function mapRole(role: string | undefined): TranscriptMessage['role'] {
  switch ((role ?? '').toLowerCase()) {
    case 'model':
    case 'assistant':
    case 'bot':
    case 'gemini':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
    case 'function':
      return 'tool';
    default:
      return 'user';
  }
}

function partsToText(parts: unknown): { text: string; toolName?: string; toolInput?: unknown } {
  if (typeof parts === 'string') return { text: parts };
  if (!Array.isArray(parts)) return { text: '' };
  const chunks: string[] = [];
  let toolName: string | undefined;
  let toolInput: unknown;
  for (const p of parts) {
    if (typeof p === 'string') {
      chunks.push(p);
      continue;
    }
    if (!isRecord(p)) continue;
    const t = asString(p.text);
    if (t) chunks.push(t);
    if (isRecord(p.functionCall)) {
      toolName = asString(p.functionCall.name) ?? toolName;
      toolInput = p.functionCall.args;
      chunks.push(`[tool: ${toolName ?? 'unknown'}]`);
    }
    if (isRecord(p.functionResponse)) {
      toolName = asString(p.functionResponse.name) ?? toolName;
      chunks.push(JSON.stringify(p.functionResponse.response ?? {}));
    }
    if (isRecord(p.inlineData)) chunks.push(`[image: ${asString(p.inlineData.mimeType) ?? 'unknown'}]`);
  }
  return { text: chunks.join('\n'), ...(toolName ? { toolName } : {}), ...(toolInput !== undefined ? { toolInput } : {}) };
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function turnsToMessages(turns: unknown[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const turn of turns) {
    if (!isRecord(turn)) continue;
    const { text, toolName, toolInput } = partsToText(turn.parts ?? turn.content ?? turn.text);
    const body = (text || asString(turn.text) || asString(turn.content) || '').trim();
    if (!body) continue;
    const ts = asString(turn.create_time) ?? asString(turn.timestamp) ?? asString(turn.time);
    out.push({
      role: toolName && !turn.role ? 'tool' : mapRole(asString(turn.role) ?? asString(turn.author)),
      content: body,
      ...(ts ? { ts } : {}),
      ...(toolName ? { toolName } : {}),
      ...(toolInput !== undefined ? { toolInput } : {}),
    });
  }
  return out;
}

/** Takeout emits one activity record per prompt, not a threaded conversation. */
function takeoutToTranscript(records: unknown[], origin: string | undefined): Transcript | undefined {
  const messages: TranscriptMessage[] = [];
  let first: string | undefined;
  let last: string | undefined;
  for (const r of records) {
    if (!isRecord(r)) continue;
    const title = asString(r.title);
    if (!title || !/^Prompted\s/i.test(title)) continue;
    const ts = asString(r.time);
    if (ts) {
      first = first ?? ts;
      last = ts;
    }
    messages.push({ role: 'user', content: stripHtml(title.replace(/^Prompted\s+/i, '')), ...(ts ? { ts } : {}) });
    const details = Array.isArray(r.details) ? r.details : [];
    const answer = details.map((d) => (isRecord(d) ? (asString(d.name) ?? '') : '')).join('\n');
    if (answer) messages.push({ role: 'assistant', content: stripHtml(answer), ...(ts ? { ts } : {}) });
  }
  if (!messages.length) return undefined;
  // Takeout is newest-first.
  if (first && last && first > last) messages.reverse();
  return {
    id: id('gemini'),
    source: 'gemini',
    title: 'Gemini activity',
    messages,
    ...(origin ? { origin } : {}),
    meta: { format: 'takeout-activity' },
  };
}

export function parseGeminiJson(content: string, origin?: string): Transcript[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (cause) {
    throw new HuskError('E_IMPORT_FAILED', `${origin ?? 'input'} is not valid JSON.`, {
      hint: 'Gemini imports expect a CLI checkpoint or a Takeout JSON file.',
      cause,
    });
  }

  const list = Array.isArray(data) ? data : [data];

  const takeout = takeoutToTranscript(list, origin);
  if (takeout) return [takeout];

  const out: Transcript[] = [];
  for (const conv of list) {
    if (!isRecord(conv)) continue;
    const turns =
      (Array.isArray(conv.messages) && conv.messages) ||
      (Array.isArray(conv.contents) && conv.contents) ||
      (Array.isArray(conv.message_list) && conv.message_list) ||
      (Array.isArray(conv.history) && conv.history) ||
      undefined;

    let messages = turns ? turnsToMessages(turns) : [];

    if (!messages.length && (conv.user_query || conv.model_response)) {
      const q = asString(conv.user_query);
      const a = asString(conv.model_response);
      const ts = asString(conv.create_time) ?? asString(conv.timestamp);
      messages = [
        ...(q ? [{ role: 'user' as const, content: q, ...(ts ? { ts } : {}) }] : []),
        ...(a ? [{ role: 'assistant' as const, content: a, ...(ts ? { ts } : {}) }] : []),
      ];
    }
    if (!messages.length) continue;

    out.push({
      id: asString(conv.conversation_id) ?? asString(conv.sessionId) ?? asString(conv.id) ?? id('gemini'),
      source: 'gemini',
      messages,
      ...(asString(conv.title) ? { title: asString(conv.title) as string } : {}),
      ...(origin ? { origin } : {}),
    });
  }
  return out;
}

export class GeminiImporter implements TranscriptImporter {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini';

  async detect(input: { path?: string; content?: string }): Promise<number> {
    try {
      const path = input.path?.replace(/\\/g, '/').toLowerCase();
      let score = 0;
      if (path?.includes('/.gemini/')) score = 0.7;
      else if (path?.includes('gemini') && path.endsWith('.json')) score = 0.55;

      const probe = input.content?.slice(0, 64 * 1024);
      if (probe) {
        if (/"role"\s*:\s*"model"/.test(probe)) score = Math.max(score, 0.9);
        if (/"functionCall"|"inlineData"/.test(probe)) score = Math.max(score, 0.8);
        if (/"header"\s*:\s*"Gemini/.test(probe)) score = Math.max(score, 0.95);
        if (/"message_list"|"user_query"|"model_response"/.test(probe)) score = Math.max(score, 0.75);
      }
      return score;
    } catch {
      return 0;
    }
  }

  async parse(input: ImportInput): Promise<Transcript[]> {
    if (input.content !== undefined) return parseGeminiJson(input.content, input.path);
    if (!input.path) {
      throw new HuskError('E_IMPORT_FAILED', 'Gemini import needs a path or content.', {
        hint: 'Point it at a Gemini CLI checkpoint json or a Takeout activity file.',
      });
    }
    const files = (await isDirectory(input.path)) ? await listFiles(input.path, '.json') : [input.path];
    const out: Transcript[] = [];
    for (const f of files) out.push(...parseGeminiJson(await readFile(f, 'utf8'), f));
    return out;
  }

  defaultLocations(): string[] {
    return [join(homedir(), '.gemini', 'tmp')];
  }
}
