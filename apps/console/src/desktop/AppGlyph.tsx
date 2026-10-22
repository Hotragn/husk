import type { DesktopComputer } from './bridge';
import { logoOf } from './logos';

/**
 * Monograms for chat apps with neither a mark in logos.ts nor an icon the
 * desktop app found on this machine: Codex, and VS Code where it is not
 * installed in the usual place.
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

// The husk, on a 26 x 24 grid: a hairline monitor, curved more at the top,
// whose white screen holds the mark, on a tiny stand.
const SHELL = 'M5 .75h16A4.25 4.25 0 0 1 25.25 5v10.25a3 3 0 0 1-3 3H3.75a3 3 0 0 1-3-3V5A4.25 4.25 0 0 1 5 .75z';
const SCREEN = 'M5.25 2.25h15.5a3 3 0 0 1 3 3v9.75a1.75 1.75 0 0 1-1.75 1.75H4a1.75 1.75 0 0 1-1.75-1.75V5.25a3 3 0 0 1 3-3z';

/**
 * The chat app a computer belongs to: the app's own installed icon, else its
 * mark on a small white tile, else a monogram. Decorative: callers label it.
 * `soft` pales a monogram to a tint with its colour as the letter. `husk`
 * draws it on the white screen of a very thin, nearly invisible computer, so
 * it reads as a Husk computer running that app rather than the app itself.
 * The husk's lines take the colour of the text around it, faintly.
 */
export function AppGlyph({
  computer,
  size = 20,
  soft = false,
  husk = false,
}: {
  computer: Pick<DesktopComputer, 'platform' | 'icon'>;
  size?: number;
  soft?: boolean;
  husk?: boolean;
}) {
  if (husk) return <Husk computer={computer} size={size} />;
  if (computer.icon) {
    return <img className="glyph" src={computer.icon} width={size} height={size} alt="" draggable={false} />;
  }
  const logo = logoOf(computer.platform);
  if (logo) {
    const mark = Math.round(size * 0.66);
    return (
      <span className="glyph glyph-logo" aria-hidden="true" style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" width={mark} height={mark} fill={logo.hex} focusable="false">
          <path d={logo.path} />
        </svg>
      </span>
    );
  }
  const m = monogram(computer.platform);
  return (
    <span
      className="glyph glyph-mono"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: soft ? `color-mix(in srgb, ${m.color} 18%, #fff)` : m.color,
        ...(soft ? { color: m.color } : {}),
        fontSize: Math.round(size * (m.text.length > 1 ? 0.42 : 0.55)),
      }}
    >
      {m.text}
    </span>
  );
}

function Husk({ computer, size }: { computer: Pick<DesktopComputer, 'platform' | 'icon'>; size: number }) {
  const logo = computer.icon ? undefined : logoOf(computer.platform);
  const m = monogram(computer.platform);
  return (
    <svg className="glyph-husk" viewBox="0 0 26 24" width={Math.round((size * 26) / 24)} height={size} aria-hidden="true" focusable="false">
      <path d={SHELL} fill="none" stroke="currentColor" strokeOpacity="0.38" strokeWidth="1" />
      <path d={SCREEN} fill="#fff" />
      <rect x="11.5" y="18.25" width="3" height="3.1" fill="currentColor" fillOpacity="0.3" />
      <path d="M8.75 22.6h8.5" stroke="currentColor" strokeOpacity="0.34" strokeWidth="1.1" strokeLinecap="round" />
      {computer.icon ? (
        <image href={computer.icon} x="8.25" y="4.75" width="9.5" height="9.5" />
      ) : logo ? (
        <svg x="8" y="4.5" width="10" height="10" viewBox="0 0 24 24" fill={logo.hex}>
          <path d={logo.path} />
        </svg>
      ) : (
        <text x="13" y="12.4" textAnchor="middle" fontSize={m.text.length > 1 ? 6.4 : 8} fontWeight="700" fill={m.color} fontFamily="ui-monospace, monospace">
          {m.text}
        </text>
      )}
    </svg>
  );
}
