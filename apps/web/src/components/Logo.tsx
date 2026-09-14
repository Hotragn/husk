/**
 * The mark and the wordmark, inlined verbatim from brand/logo/*.svg.
 *
 * Inlined rather than <img>-ed because that is what makes --husk-mark-shell,
 * --husk-mark-core and --husk-word resolve against the page theme instead of
 * the operating system's (brand/logo/USAGE.md, "On dark and on light").
 *
 * The path data is untouched. No glow, no gradient, no rotation, no bevel —
 * USAGE.md "Misuse" 3 through 6.
 */

export function HuskMark({
  size = 32,
  title,
}: {
  size?: number;
  title?: string;
}) {
  const decorative = !title;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role="img"
      aria-hidden={decorative || undefined}
      focusable="false"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {/* Shell: the heavy half of the husk. */}
      <path
        className="husk-shell"
        d="M13 1.5 L3.5 9 L1.5 19 L9 30.5 L17 28 L13.5 22 L12.5 15.5 L15.5 8.5 L20 4 Z"
      />
      {/* Flap: the peeled half. The asymmetry is load-bearing. */}
      <path
        className="husk-shell"
        d="M23.5 3 L30 10 L30.5 20 L26 27.5 L23.5 20 L23.8 11 Z"
      />
      {/* Core: one asymmetric blade. It is also a caret. */}
      <path className="husk-core" d="M18.2 9.5 L21 15 L18.8 26.5 L15.5 15.5 Z" />
    </svg>
  );
}

export function HuskWordmark({ height = 20 }: { height?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 182 68"
      height={height}
      width={(182 / 68) * height}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <g
        className="husk-word"
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="butt"
        strokeLinejoin="bevel"
      >
        <path d="M4.5 0 L4.5 68" />
        <path d="M4.5 40 L13 28.5 L28 28.5 L36.5 40 L36.5 68" />
        <path d="M58.5 24 L58.5 52 L67 63.5 L82 63.5 L90.5 52 L90.5 24" />
        <path d="M136 28.5 L113 28.5 L129 63.5 L106 63.5" />
        <path d="M153.5 0 L153.5 68" />
        <path d="M179 27.9 L152.5 43 L179 64.5" />
      </g>
    </svg>
  );
}
