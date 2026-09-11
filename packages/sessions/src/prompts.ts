import { z } from 'zod';
import type { TranscriptMessage } from '@husk/core';

/**
 * Every prompt the distiller sends, as a pure function of its inputs.
 *
 * They live here so they can be diffed, reviewed and unit-tested without a
 * network. A prompt buried in a method is a prompt nobody ever reads again.
 */

export const CandidateSchema = z.object({
  name: z.string().default(''),
  description: z.string().default(''),
  /** One rule per entry, imperative, in the user's own words where possible. */
  personaRules: z.array(z.string()).default([]),
  knowledge: z
    .array(z.object({ title: z.string(), content: z.string() }))
    .default([]),
  examples: z.array(z.object({ user: z.string(), assistant: z.string() })).default([]),
  tools: z.array(z.string()).default([]),
  needsComputer: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const MergedSchema = CandidateSchema.extend({
  persona: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type Merged = z.infer<typeof MergedSchema>;

export interface WindowMeta {
  index: number;
  total: number;
  title?: string;
  source: string;
}

const JSON_ONLY = 'Reply with one JSON object and nothing else. No prose, no markdown fence.';

export function extractSystemPrompt(): string {
  return [
    'You read one slice of a chat transcript and report what the user taught the assistant.',
    '',
    'You are building a reusable bot from a real conversation. Report only what the',
    'transcript shows. Do not generalise, do not invent capabilities, do not write a',
    'persona for an assistant that would be nice to have.',
    '',
    'Rules:',
    '- personaRules: standing instructions the user gave ("always...", "never...",',
    '  "use X", "you are..."). Quote or lightly normalise the user\'s wording.',
    '  A one-off request for this task is not a standing instruction.',
    '- knowledge: durable facts the USER supplied (systems, names, conventions,',
    '  constraints). Never facts the assistant produced.',
    '- examples: an exchange worth imitating. Skip any turn the user then corrected.',
    '- tools: tool names actually used in this slice, verbatim.',
    '- notes: what this slice could not tell you.',
    '',
    JSON_ONLY,
    'Shape: {"name":"","description":"","personaRules":[],"knowledge":[{"title":"","content":""}],',
    '"examples":[{"user":"","assistant":""}],"tools":[],"needsComputer":false,"notes":[]}',
  ].join('\n');
}

export function extractUserPrompt(windowText: string, meta: WindowMeta): string {
  return [
    `Transcript: ${meta.title ?? '(untitled)'} (source: ${meta.source})`,
    `Slice ${meta.index + 1} of ${meta.total}.`,
    '',
    '--- BEGIN SLICE ---',
    windowText,
    '--- END SLICE ---',
    '',
    'Report this slice as JSON.',
  ].join('\n');
}

export function mergeSystemPrompt(): string {
  return [
    'You merge per-slice reports of one conversation into a single bot definition.',
    '',
    'Rules:',
    '- A rule that appears in several slices is a real standing instruction. Keep it.',
    '- A rule that appears once and contradicts a later slice is stale. Drop it.',
    '- Deduplicate aggressively. Twelve rules that say the same thing is one rule.',
    '- persona: a system prompt written in the second person. Open with who the bot',
    '  is, then the rules as a short list. No filler, no "As an AI".',
    '- Keep at most 8 knowledge items and 6 examples, the most reusable ones.',
    '- confidence: 0..1, how much of a working bot the transcript actually supports.',
    '  Be honest. A transcript with no standing instructions is not a 0.9.',
    '',
    JSON_ONLY,
    'Shape: {"name":"","description":"","persona":"","personaRules":[],',
    '"knowledge":[{"title":"","content":""}],"examples":[{"user":"","assistant":""}],',
    '"tools":[],"needsComputer":false,"confidence":0.5,"notes":[]}',
  ].join('\n');
}

export function mergeUserPrompt(candidates: Candidate[], meta: { title?: string; source: string }): string {
  return [
    `Transcript: ${meta.title ?? '(untitled)'} (source: ${meta.source})`,
    `${candidates.length} slice report(s) follow.`,
    '',
    JSON.stringify(candidates, null, 2),
    '',
    'Merge into one JSON object.',
  ].join('\n');
}

/** Render messages for a model: role-tagged, tool calls named, results clamped. */
export function renderWindow(messages: TranscriptMessage[], maxToolResultChars = 600): string {
  return messages
    .map((m) => {
      if (m.role === 'tool') {
        const body = m.content.length > maxToolResultChars
          ? `${m.content.slice(0, maxToolResultChars)} ... [${m.content.length - maxToolResultChars} chars elided]`
          : m.content;
        return `TOOL RESULT (${m.toolName ?? 'unknown'}): ${body}`;
      }
      if (m.toolName) {
        const args = m.toolInput === undefined ? '' : ` ${JSON.stringify(m.toolInput).slice(0, 300)}`;
        return `${m.role.toUpperCase()} CALLS ${m.toolName}:${args}`;
      }
      return `${m.role.toUpperCase()}: ${m.content}`;
    })
    .join('\n\n');
}
