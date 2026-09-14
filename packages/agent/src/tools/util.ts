import type { JSONSchema } from '@husk/core';

/** Join an argv array into something safe to hand a POSIX shell. */
export function shellQuote(args: string[]): string {
  return args
    .map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

export function object(
  properties: Record<string, JSONSchema>,
  required: string[] = [],
): JSONSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const str = (description: string, extra: JSONSchema = {}): JSONSchema => ({
  type: 'string',
  description,
  ...extra,
});

export const int = (description: string, extra: JSONSchema = {}): JSONSchema => ({
  type: 'integer',
  description,
  ...extra,
});

export const bool = (description: string, extra: JSONSchema = {}): JSONSchema => ({
  type: 'boolean',
  description,
  ...extra,
});

/** Read a numeric field that a model may have serialised as a string. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function firstLine(s: string, max = 120): string {
  const line = s.split('\n', 1)[0] ?? '';
  return line.length > max ? line.slice(0, max) + '...' : line;
}
