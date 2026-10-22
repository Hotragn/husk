import type { DesktopComputer } from './bridge';

/**
 * Monograms for chat apps whose own icon the desktop app could not find on
 * this machine: the terminal ones always, the others where they are not
 * installed in the usual place. Husk ships no one else's logo.
 */
const MONOGRAMS: Array<[RegExp, string, string]> = [
  [/^claude code/i, '>_', '#c96442'],
  [/^claude/i, 'C', '#c96442'],
  [/^cursor/i, 'Cu', '#1f1f1f'],
  [/^vs ?code/i, 'VS', '#1f6feb'],
  [/^windsurf/i, 'W', '#0f8a7e'],
  [/^codex/i, 'Cx', '#2b2b2b'],
  [/^gemini/i, 'G', '#4b6bfb'],
  [/^zed/i, 'Z', '#2b2b2b'],
];

export function monogram(platform: string | undefined): { text: string; color: string } {
  const name = platform ?? '';
  for (const [re, text, color] of MONOGRAMS) if (re.test(name)) return { text, color };
  return { text: (name.trim()[0] ?? 'H').toUpperCase(), color: '#3f3f46' };
}

/** The chat app a computer belongs to: its icon, else a monogram. Decorative: callers label it. */
export function AppGlyph({ computer, size = 20 }: { computer: Pick<DesktopComputer, 'platform' | 'icon'>; size?: number }) {
  if (computer.icon) {
    return <img className="glyph" src={computer.icon} width={size} height={size} alt="" draggable={false} />;
  }
  const m = monogram(computer.platform);
  return (
    <span
      className="glyph glyph-mono"
      aria-hidden="true"
      style={{ width: size, height: size, background: m.color, fontSize: Math.round(size * (m.text.length > 1 ? 0.42 : 0.55)) }}
    >
      {m.text}
    </span>
  );
}
