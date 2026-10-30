import { ImageResponse } from "next/og";

/**
 * The share card for the docs site.
 *
 * One pipeline, two jobs: the same 1200x630 PNG is what a link unfurls to in a
 * chat window and what a hover preview shows before the reader commits to a
 * click.
 *
 * A near-copy of apps/web/src/lib/og-card.tsx, and deliberately a copy: these
 * are two Next apps with two builds and no shared workspace package between
 * them. The literal hex values below are the same tokens for the same reason.
 *
 * Satori has no DOM and therefore no custom properties, so these are the only
 * literal hex values in the app. Every one is copied from brand/tokens.css:
 *   bg #0f0b07  surface #1b1611  sunken #070503  border #36312a
 *   text #f8f5f1  muted #bdb8b1  subtle #9e9992  gold #deb076  teal #42d0cf
 * Keep them in step if the palette ever moves.
 */

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

export const C = {
  bg: "#0f0b07",
  surface: "#1b1611",
  sunken: "#070503",
  border: "#36312a",
  text: "#f8f5f1",
  muted: "#bdb8b1",
  subtle: "#9e9992",
  gold: "#deb076",
  teal: "#42d0cf",
};

/* The mark, as a data URI. Satori renders <img> reliably; inline SVG trees are
   more fragile. Geometry is brand/logo/mark.svg's, token colours baked in. */
const MARK = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
     <path fill="${C.gold}" d="M13 1.5 L3.5 9 L1.5 19 L9 30.5 L17 28 L13.5 22 L12.5 15.5 L15.5 8.5 L20 4 Z"/>
     <path fill="${C.gold}" d="M23.5 3 L30 10 L30.5 20 L26 27.5 L23.5 20 L23.8 11 Z"/>
     <path fill="${C.teal}" d="M18.2 9.5 L21 15 L18.8 26.5 L15.5 15.5 Z"/>
   </svg>`,
)}`;

export interface OgCard {
  /** Small label above the headline. The section, or the site. */
  eyebrow?: string;
  /** The claim. Kept short enough to stay on three lines at 88px. */
  title: string;
  /** One sentence under it. */
  lead?: string;
  /** A command, shown in a terminal frame. Mutually exclusive with `note`. */
  command?: string;
  /** The line along the bottom. */
  note?: string;
}

export function ogCard({ eyebrow, title, lead, command, note }: OgCard) {
  /* Long titles get a smaller size rather than a clipped third line. Satori
     does not reflow-and-measure, so this is done by length. */
  const titleSize = title.length > 52 ? 62 : title.length > 34 ? 74 : 88;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: C.bg,
          padding: "72px 80px",
          color: C.text,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={MARK} width={44} height={44} alt="" />
          <div style={{ display: "flex", fontSize: 30, letterSpacing: "-0.01em" }}>husk docs</div>
          {eyebrow ? (
            <div
              style={{
                display: "flex",
                marginLeft: 12,
                paddingLeft: 18,
                borderLeft: `1px solid ${C.border}`,
                fontSize: 26,
                color: C.subtle,
              }}
            >
              {eyebrow}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: titleSize,
              lineHeight: 1.04,
              letterSpacing: "-0.032em",
            }}
          >
            {title}
          </div>
          {lead ? (
            <div
              style={{
                display: "flex",
                marginTop: 26,
                fontSize: 30,
                lineHeight: 1.4,
                letterSpacing: "-0.005em",
                color: C.muted,
                maxWidth: 940,
              }}
            >
              {lead}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {command ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                background: C.sunken,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: "18px 24px",
                fontSize: 28,
              }}
            >
              <span style={{ color: C.gold, marginRight: 14 }}>$</span>
              {command}
            </div>
          ) : null}
          {note ? (
            <div
              style={{
                display: "flex",
                marginTop: command ? 22 : 0,
                fontSize: 22,
                color: C.subtle,
              }}
            >
              {note}
            </div>
          ) : null}
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
