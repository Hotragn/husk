/**
 * The 3D computers' colours, after the colours an iMac comes in: a deep back,
 * stand and edges, and a pale chin under a white bezel. A chat app keeps one
 * colour, so its computers are recognisable across the row at a glance; an
 * app not listed gets a steady colour from the computer's id.
 */

export type TintName = 'blue' | 'green' | 'pink' | 'silver' | 'yellow' | 'orange' | 'purple';

export const TINTS: Record<TintName, { back: string; chin: string }> = {
  blue: { back: '#3f6cc4', chin: '#9fb9ea' },
  green: { back: '#3b8a63', chin: '#9fd1b3' },
  pink: { back: '#d4607b', chin: '#eeaabb' },
  silver: { back: '#b9bdc4', chin: '#d3d6db' },
  yellow: { back: '#dca93a', chin: '#efd282' },
  orange: { back: '#d9693a', chin: '#f1ac8a' },
  purple: { back: '#7a62c2', chin: '#bfaeee' },
};

const BY_APP: Array<[RegExp, TintName]> = [
  [/^claude/i, 'orange'],
  [/^vs ?code/i, 'blue'],
  [/^windsurf/i, 'green'],
  [/^gemini/i, 'purple'],
  [/^cursor/i, 'silver'],
  [/^codex/i, 'silver'],
  [/^zed/i, 'yellow'],
];

const ORDER = Object.keys(TINTS) as TintName[];

export function tintOf(platform: string | undefined, id: string): TintName {
  for (const [re, tint] of BY_APP) if (re.test(platform ?? '')) return tint;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ORDER[h % ORDER.length] ?? 'silver';
}
