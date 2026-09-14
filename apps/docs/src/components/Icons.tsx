/**
 * The complete icon set.
 *
 * Five icons, and each one carries information the adjacent text does not:
 * search, copy, copied, menu, close, and the two theme glyphs. There are no
 * decorative icons anywhere on this site -- UI-PRINCIPLES section 8.7.
 *
 * All of them are `aria-hidden` and `focusable="false"`; the accessible name
 * lives on the button that contains them.
 */

import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
};

export function SearchIcon() {
  return (
    <svg {...base}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg {...base}>
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.25 3.25A1.5 1.5 0 0 0 8.75 1.75h-5a2 2 0 0 0-2 2v5a1.5 1.5 0 0 0 1.5 1.5" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...base}>
      <path d="m2.5 8.5 3.5 3.5 7.5-8" />
    </svg>
  );
}

export function MenuIcon() {
  return (
    <svg {...base}>
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...base}>
      <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

/** Shown when the page is dark: clicking moves to light. */
export function SunIcon() {
  return (
    <svg {...base} className="theme-icon-dark">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.95 3.05l-1.06 1.06M4.11 11.89l-1.06 1.06M12.95 12.95l-1.06-1.06M4.11 4.11 3.05 3.05" />
    </svg>
  );
}

/** Shown when the page is light: clicking moves to dark. */
export function MoonIcon() {
  return (
    <svg {...base} className="theme-icon-light">
      <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" />
    </svg>
  );
}

/**
 * The Husk mark: a split husk with a lit core.
 *
 * Geometry copied path-for-path from brand/logo/mark.svg. It is inlined rather
 * than loaded through an `img` tag for the reason brand/logo/USAGE.md gives:
 * the file's internal `prefers-color-scheme` query reads the operating system,
 * not the surface the mark is sitting on, and this site has a manual theme
 * switch. Inlined, the fills bind to `--husk-mark-shell` / `--husk-mark-core`,
 * which globals.css points at the theme tokens -- the wiring USAGE.md calls
 * "recommended".
 */
export function HuskMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        fill="var(--husk-mark-shell)"
        d="M13 1.5 L3.5 9 L1.5 19 L9 30.5 L17 28 L13.5 22 L12.5 15.5 L15.5 8.5 L20 4 Z"
      />
      <path
        fill="var(--husk-mark-shell)"
        d="M23.5 3 L30 10 L30.5 20 L26 27.5 L23.5 20 L23.8 11 Z"
      />
      <path fill="var(--husk-mark-core)" d="M18.2 9.5 L21 15 L18.8 26.5 L15.5 15.5 Z" />
    </svg>
  );
}

/**
 * Mark plus logotype, path-for-path from brand/logo/lockup-horizontal.svg.
 *
 * The default lockup, and the one USAGE.md nominates for a site header. Live
 * text set in Bricolage Grotesque would be close but it would not be the
 * wordmark: the logotype is a monolinear faceted drawing on the mark's own
 * straight-segment grid, with bevel joins rather than miters.
 *
 * Rendered at 140px wide, which is exactly the documented minimum -- below it
 * the mark drops under its own 20px floor.
 */
export function HuskLockup() {
  return (
    <svg className="brand-lockup" viewBox="0 0 288 76" aria-hidden="true" focusable="false">
      <g transform="translate(-3.93 -3.93) scale(2.621)">
        <path
          fill="var(--husk-mark-shell)"
          d="M13 1.5 L3.5 9 L1.5 19 L9 30.5 L17 28 L13.5 22 L12.5 15.5 L15.5 8.5 L20 4 Z"
        />
        <path
          fill="var(--husk-mark-shell)"
          d="M23.5 3 L30 10 L30.5 20 L26 27.5 L23.5 20 L23.8 11 Z"
        />
        <path fill="var(--husk-mark-core)" d="M18.2 9.5 L21 15 L18.8 26.5 L15.5 15.5 Z" />
      </g>
      <g
        transform="translate(106 4)"
        fill="none"
        stroke="var(--husk-word)"
        strokeWidth={9}
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
