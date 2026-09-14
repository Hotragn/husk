import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { HuskError, id } from '@husk-ai/core';
import type { ImportInput, Transcript, TranscriptImporter, TranscriptMessage } from '@husk-ai/core';
import { isDirectory, listFiles } from './fsutil.js';

/**
 * ChatGPT data export.
 *
 * `conversations.json` is an array of conversations; each is a `mapping` of node
 * id -> { id, message, parent, children }. The thread the user actually saw is
 * `current_node` walked back to the root -- everything else is a regenerated
 * branch that was thrown away.
 */

interface Node {
  id?: string;
  message?: unknown;
  parent?: unknown;
  children?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function epochToIso(v: unknown): string | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return new Date(v * 1000).toISOString();
}

function mapRole(role: string | undefined): TranscriptMessage['role'] {
  switch ((role ?? '').toLowerCase()) {
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

/** Every `content_type` the export uses collapses to one string. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!isRecord(content)) return '';

  const parts = content.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (!isRecord(p)) return '';
        if (asString(p.text)) return asString(p.text) as string;
        // multimodal_text image pointers carry no pixels in the export.
        if (p.content_type === 'image_asset_pointer') return '[image]';
        if (p.content_type === 'audio_transcription') return asString(p.text) ?? '[audio]';
        return '';
      })
      .filter((s) => s !== '')
      .join('\n');
  }

  return asString(content.text) ?? asString(content.result) ?? '';
}

function walkCurrentThread(mapping: Record<string, Node>, currentNode: string | undefined): Node[] {
  let startId = currentNode;
  if (!startId || !mapping[startId]) {
    // No current_node: fall back to the deepest leaf, which is the longest branch.
    const hasChild = new Set<string>();
    for (const node of Object.values(mapping)) {
      const p = asString(node.parent);
      if (p) hasChild.add(p);
    }
    let bestId: string | undefined;
    let bestDepth = -1;
    for (const [nodeId, node] of Object.entries(mapping)) {
      if (hasChild.has(nodeId)) continue;
      let depth = 0;
      let cur: Node | undefined = node;
      const seen = new Set<string>();
      while (cur) {
        const p = asString(cur.parent);
        if (!p || seen.has(p)) break;
        seen.add(p);
        cur = mapping[p];
        depth++;
      }
      if (depth > bestDepth) {
        bestDepth = depth;
        bestId = nodeId;
      }
    }
    startId = bestId;
  }
  if (!startId) return [];

  const out: Node[] = [];
  const seen = new Set<string>();
  let cur: Node | undefined = mapping[startId];
  let curId: string | undefined = startId;
  while (cur && curId && !seen.has(curId)) {
    seen.add(curId);
    out.push(cur);
    curId = asString(cur.parent);
    cur = curId ? mapping[curId] : undefined;
  }
  return out.reverse();
}

function conversationToTranscript(conv: unknown, origin: string | undefined, index: number): Transcript | undefined {
  if (!isRecord(conv) || !isRecord(conv.mapping)) return undefined;
  const mapping = conv.mapping as Record<string, Node>;
  const thread = walkCurrentThread(mapping, asString(conv.current_node));

  const messages: TranscriptMessage[] = [];
  for (const node of thread) {
    const message = node.message;
    if (!isRecord(message)) continue;
    const author = isRecord(message.author) ? message.author : undefined;
    const role = mapRole(asString(author?.role));
    const meta = isRecord(message.metadata) ? message.metadata : undefined;
    if (meta?.is_visually_hidden_from_conversation === true) continue;

    const text = contentToText(message.content).trim();
    const toolName = asString(author?.name) ?? asString(meta?.['invoked_plugin']);
    if (!text && !toolName) continue;

    const ts = epochToIso(message.create_time);
    messages.push({
      role,
      content: text,
      ...(ts ? { ts } : {}),
      ...(role === 'tool' && toolName ? { toolName } : {}),
    });
  }

  if (!messages.length) return undefined;

  const created = epochToIso(conv.create_time);
  const updated = epochToIso(conv.update_time);
  return {
    id: asString(conv.conversation_id) ?? asString(conv.id) ?? id('chatgpt'),
    source: 'chatgpt',
    messages,
    ...(asString(conv.title) ? { title: asString(conv.title) as string } : {}),
    ...(created ? { createdAt: created } : {}),
    ...(updated ? { updatedAt: updated } : {}),
    ...(origin ? { origin } : {}),
    meta: { threadIndex: index, nodes: Object.keys(mapping).length, threadLength: thread.length },
  };
}

export class ChatGPTImporter implements TranscriptImporter {
  readonly id = 'chatgpt' as const;
  readonly displayName = 'ChatGPT export';

  async detect(input: { path?: string; content?: string }): Promise<number> {
    try {
      const path = input.path?.replace(/\\/g, '/').toLowerCase();
      let score = 0;
      if (path?.endsWith('conversations.json')) score = 0.9;
      else if (path?.endsWith('.json')) score = 0.15;

      const probe = input.content?.slice(0, 64 * 1024);
      if (probe) {
        const markers = [/"mapping"\s*:/, /"current_node"\s*:/, /"content_type"\s*:/, /"author"\s*:\s*\{/].filter(
          (re) => re.test(probe),
        ).length;
        if (markers >= 3) score = Math.max(score, 0.95);
        else if (markers === 2) score = Math.max(score, 0.7);
      }
      return score;
    } catch {
      return 0;
    }
  }

  async parse(input: ImportInput): Promise<Transcript[]> {
    const sources: Array<{ content: string; origin?: string }> = [];

    if (input.content !== undefined) {
      sources.push({ content: input.content, ...(input.path ? { origin: input.path } : {}) });
    } else if (input.path) {
      const files = (await isDirectory(input.path))
        ? await listFiles(input.path, '.json').then((fs2) => fs2.filter((f) => f.endsWith('conversations.json')))
        : [input.path];
      for (const f of files) {
        try {
          sources.push({ content: await readFile(f, 'utf8'), origin: f });
        } catch (cause) {
          throw new HuskError('E_IMPORT_FAILED', `Cannot read ${f}.`, {
            hint: 'Check the path exists and is readable.',
            cause,
          });
        }
      }
    } else {
      throw new HuskError('E_IMPORT_FAILED', 'ChatGPT import needs a path or content.', {
        hint: 'Point it at the conversations.json inside your ChatGPT export zip.',
      });
    }

    const out: Transcript[] = [];
    for (const src of sources) {
      let data: unknown;
      try {
        data = JSON.parse(src.content);
      } catch (cause) {
        throw new HuskError('E_IMPORT_FAILED', `${src.origin ?? 'input'} is not valid JSON.`, {
          hint: 'Use the conversations.json from the export, not the html file.',
          cause,
        });
      }
      const list = Array.isArray(data) ? data : [data];
      list.forEach((conv, i) => {
        const t = conversationToTranscript(conv, src.origin, i);
        if (t) out.push(t);
      });
    }
    return out;
  }

  defaultLocations(): string[] {
    const home = homedir();
    return [join(home, 'Downloads'), join(home, 'Documents')];
  }
}
