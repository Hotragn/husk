import { readFile } from 'node:fs/promises';
import { clampText, HuskError, id } from '@husk-ai/core';
import type { ImportInput, Transcript, TranscriptImporter, TranscriptMessage } from '@husk-ai/core';
import type { ChatLike } from '../chat.js';
import { parseMarkdownChat } from './markdown.js';

/**
 * The last resort: a chat pasted out of an interface nobody wrote an importer
 * for. It tries the markdown heuristics first, because they cost nothing and
 * are right surprisingly often, and only then asks a model.
 *
 * With no model reachable it still returns whatever the heuristics found. This
 * package has no hard dependency on a network.
 */

const SYSTEM =`You convert a raw text dump of a chat into JSON.
Return a JSON array of messages and nothing else -- no prose, no markdown fence.
Each element: {"role":"user"|"assistant"|"system"|"tool","content":"..."}.
Preserve the original wording. Do not summarise, translate, or invent turns.`;

function stripFence(s: string): string {
  const trimmed = s.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function mapRole(role: unknown): TranscriptMessage['role'] {
  switch (String(role ?? '').toLowerCase()) {
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
    default:
      return 'user';
  }
}

export class UniversalImporter implements TranscriptImporter {
  readonly id = 'universal' as const;
  readonly displayName = 'Universal (model-assisted)';

  /** Injected so tests never touch a network and callers control the budget. */
  constructor(
    private readonly model?: ChatLike,
    private readonly opts: { model?: string; maxBytes?: number } = {},
  ) {}

  async detect(): Promise<number> {
    // Deliberately below every real importer. This one only wins when nothing
    // else recognised the input at all.
    return 0.05;
  }

  async parse(input: ImportInput): Promise<Transcript[]> {
    let content = input.content;
    if (content === undefined) {
      if (!input.path) {
        throw new HuskError('E_IMPORT_FAILED', 'Universal import needs a path or content.', {
          hint: 'Pass { content } with the pasted chat text.',
        });
      }
      content = await readFile(input.path, 'utf8');
    }
    if (!content.trim()) return [];

    const heuristic = parseMarkdownChat(content, input.path);
    if (heuristic && heuristic.messages.length >= 2) {
      heuristic.source = 'universal';
      heuristic.meta = { ...(heuristic.meta ?? {}), extractedBy: 'heuristic' };
      return [heuristic];
    }
    if (!this.model) return heuristic ? [{ ...heuristic, source: 'universal' }] : [];

    const { text: clamped } = clampText(content, this.opts.maxBytes ?? 120_000);
    try {
      const res = await this.model.chat({
        model: this.opts.model ?? 'auto',
        system: SYSTEM,
        messages: [{ role: 'user', content: clamped }],
        temperature: 0,
        responseFormat: { type: 'json' },
      });
      const parsed: unknown = JSON.parse(stripFence(res.text));
      const rows = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { messages?: unknown }).messages)
          ? ((parsed as { messages: unknown[] }).messages)
          : [];
      const messages: TranscriptMessage[] = rows
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({ role: mapRole(r.role), content: String(r.content ?? '') }))
        .filter((m) => m.content.trim() !== '');
      if (!messages.length) return heuristic ? [{ ...heuristic, source: 'universal' }] : [];

      return [
        {
          id: id('universal'),
          source: 'universal',
          messages,
          ...(input.path ? { origin: input.path } : {}),
          meta: { extractedBy: 'model' },
        },
      ];
    } catch {
      // A model that is down, rate limited, or hallucinating JSON must not lose
      // the input. Hand back whatever the heuristics managed.
      return heuristic ? [{ ...heuristic, source: 'universal' }] : [];
    }
  }
}
