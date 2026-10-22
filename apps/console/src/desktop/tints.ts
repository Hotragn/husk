/**
 * The 3D computers' colours, after the colours an iMac comes in, softened so
 * they sit quietly on any desktop: a muted back, stand and edges, and a paler
 * chin under a white bezel. A chat app keeps one colour, so its computers are
 * recognisable across the row at a glance; an app not listed gets a steady
 * colour from the computer's id.
 */

export type TintName = 'blue' | 'green' | 'pink' | 'silver' | 'yellow' | 'orange' | 'purple';

export const TINTS: Record<TintName, { back: string; chin: string }> = {
  blue: { back: '#9db3d9', chin: '#d3def0' },
  green: { back: '#9fc4ae', chin: '#d5e7dc' },
  pink: { back: '#e2adbb', chin: '#f1d7de' },
  silver: { back: '#c9ccd2', chin: '#e3e5e8' },
  yellow: { back: '#e4d099', chin: '#f2e8cb' },
  orange: { back: '#e7b499', chin: '#f3dccf' },
  purple: { back: '#b5a9dc', chin: '#ded8f0' },
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
