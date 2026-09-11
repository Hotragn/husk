import { homedir } from 'node:os';
import { redact as redactSecrets } from '@husk/core';
import type { DistilledAgent, Transcript, TranscriptMessage } from '@husk/core';

/**
 * Everything that leaves this package -- to disk, to a model, to a log -- goes
 * through here first. Transcripts are the single richest source of secrets a
 * user owns: they contain whatever got pasted into a chat window.
 */

export type RedactionKind = 'secret' | 'home-path' | 'email';

export interface RedactionReport {
  total: number;
  counts: Record<RedactionKind, number>;
  /** One line the CLI can print verbatim. Never contains a redacted value. */
  summary: string;
}

export interface RedactOptions {
  /** Replace the current user's home directory and any sibling home with `~`. */
  homePaths?: boolean;
  /** Replace email addresses with `[email]`. */
  emails?: boolean;
  /** Run `redact()` from @husk/core over credential-shaped strings. */
  secrets?: boolean;
}

const DEFAULTS: Required<RedactOptions> = { homePaths: true, emails: true, secrets: true };

/**
 * Ordered longest-form-first so the escaped `C:\\Users\\x` form is consumed
 * before the single-backslash pattern can eat half of it.
 */
const HOME_PATTERNS: RegExp[] = [
  /[A-Za-z]:\\\\Users\\\\[^\\"'\s:*?<>|]+/g,
  /[A-Za-z]:\\Users\\[^\\/"'\s:*?<>|]+/g,
  /[A-Za-z]:\/Users\/[^\\/"'\s:*?<>|]+/g,
  /\/home\/[A-Za-z0-9._][A-Za-z0-9._-]*/g,
  /\/Users\/[A-Za-z0-9._][A-Za-z0-9._-]*/g,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;

function emptyCounts(): Record<RedactionKind, number> {
  return { secret: 0, 'home-path': 0, email: 0 };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The literal home directory of the running user, in every spelling it appears in. */
function literalHomePatterns(): RegExp[] {
  const home = homedir();
  if (!home) return [];
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]);
  return [...variants].map((v) => new RegExp(escapeRegex(v), 'gi'));
}

function countingReplace(
  input: string,
  pattern: RegExp,
  replacement: string,
): { text: string; hits: number } {
  let hits = 0;
  const text = input.replace(pattern, () => {
    hits++;
    return replacement;
  });
  return { text, hits };
}

function summarise(counts: Record<RedactionKind, number>): string {
  const parts: string[] = [];
  if (counts.secret) parts.push(`${counts.secret} credential${counts.secret === 1 ? '' : 's'}`);
  if (counts['home-path'])
    parts.push(`${counts['home-path']} home path${counts['home-path'] === 1 ? '' : 's'}`);
  if (counts.email) parts.push(`${counts.email} email${counts.email === 1 ? '' : 's'}`);
  if (!parts.length) return 'nothing to redact';
  return `redacted ${parts.join(', ')}`;
}

/** Scrub one string. The report says what was removed, never what it was. */
export function redactText(
  input: string,
  opts: RedactOptions = {},
): { text: string; report: RedactionReport } {
  const o = { ...DEFAULTS, ...opts };
  const counts = emptyCounts();
  let text = input;

  if (o.secrets) {
    const before = text;
    text = redactSecrets(text);
    // core's redact() does not count, so infer from the marker it leaves behind.
    if (text !== before) {
      counts.secret =
        (text.match(/\[redacted(?: private key)?\]/g) ?? []).length -
        (before.match(/\[redacted(?: private key)?\]/g) ?? []).length;
      if (counts.secret < 1) counts.secret = 1;
    }
  }

  if (o.homePaths) {
    for (const p of [...literalHomePatterns(), ...HOME_PATTERNS]) {
      const r = countingReplace(text, p, '~');
      text = r.text;
      counts['home-path'] += r.hits;
    }
  }

  if (o.emails) {
    const r = countingReplace(text, EMAIL, '[email]');
    text = r.text;
    counts.email += r.hits;
  }

  const total = counts.secret + counts['home-path'] + counts.email;
  return { text, report: { total, counts, summary: summarise(counts) } };
}

function mergeInto(target: RedactionReport, add: RedactionReport): void {
  target.counts.secret += add.counts.secret;
  target.counts['home-path'] += add.counts['home-path'];
  target.counts.email += add.counts.email;
  target.total = target.counts.secret + target.counts['home-path'] + target.counts.email;
  target.summary = summarise(target.counts);
}

export function emptyReport(): RedactionReport {
  return { total: 0, counts: emptyCounts(), summary: summarise(emptyCounts()) };
}

/** Scrub every string a transcript carries: title, origin, message bodies, tool input. */
export function redactTranscript(
  transcript: Transcript,
  opts: RedactOptions = {},
): { transcript: Transcript; report: RedactionReport } {
  const report = emptyReport();
  const take = (s: string): string => {
    const r = redactText(s, opts);
    mergeInto(report, r.report);
    return r.text;
  };

  const messages: TranscriptMessage[] = transcript.messages.map((m) => {
    const next: TranscriptMessage = { ...m, content: take(m.content) };
    if (m.toolInput !== undefined) {
      try {
        next.toolInput = JSON.parse(take(JSON.stringify(m.toolInput))) as unknown;
      } catch {
        next.toolInput = '[unserialisable tool input]';
      }
    }
    return next;
  });

  const out: Transcript = { ...transcript, messages };
  if (transcript.title) out.title = take(transcript.title);
  if (transcript.origin) out.origin = take(transcript.origin);
  return { transcript: out, report };
}

/** Scrub a distilled agent before it is written as a husk.yaml. */
export function redactDistilled(
  agent: DistilledAgent,
  opts: RedactOptions = {},
): { agent: DistilledAgent; report: RedactionReport } {
  const report = emptyReport();
  const take = (s: string): string => {
    const r = redactText(s, opts);
    mergeInto(report, r.report);
    return r.text;
  };

  return {
    agent: {
      ...agent,
      name: take(agent.name),
      description: take(agent.description),
      persona: take(agent.persona),
      knowledge: agent.knowledge.map((k) => ({
        title: take(k.title),
        content: take(k.content),
        ...(k.source ? { source: take(k.source) } : {}),
      })),
      examples: agent.examples.map((e) => ({ user: take(e.user), assistant: take(e.assistant) })),
      notes: agent.notes.map(take),
    },
    report,
  };
}
