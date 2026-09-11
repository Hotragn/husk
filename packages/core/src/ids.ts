import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no i/l/o/u

/** Short, URL-safe id. */
export function id(prefix?: string, len = 12): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

/** Id with a millisecond time prefix -- sorts lexicographically by creation. */
export function tid(prefix?: string): string {
  const t = Date.now().toString(36).padStart(9, '0');
  return `${prefix ? prefix + '_' : ''}${t}${id(undefined, 6)}`;
}

/** Deterministic, filesystem-safe slug. */
export function slug(input: string, max = 48): string {
  const s = input
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, max)
    .replace(/^-|-$/g, '');
  return s || 'husk';
}
