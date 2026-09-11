import { ImageResponse } from "next/og";

export const alt =
  "Husk — give your agent a computer. claude mcp add husk -- npx -y @husk/mcp";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The share card is rendered by Satori, which has no DOM and therefore no
 * custom properties. These are the only literal hex values in the app, and
 * every one of them is copied from brand/tokens.css:
 *   bg #0f0b07  surface #1b1611  border #36312a  text #f8f5f1
 *   muted #bdb8b1  subtle #9e9992  gold #deb076  teal #42d0cf
 * Keep them in step with tokens.css if the palette ever moves.
 */
const C = {
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
   more fragile. Geometry is mark.svg's, with the token colours baked in. */
const MARK = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
     <path fill="${C.gold}" d="M13 1.5 L3.5 9 L1.5 19 L9 30.5 L17 28 L13.5 22 L12.5 15.5 L15.5 8.5 L20 4 Z"/>
     <path fill="${C.gold}" d="M23.5 3 L30 10 L30.5 20 L26 27.5 L23.5 20 L23.8 11 Z"/>
     <path fill="${C.teal}" d="M18.2 9.5 L21 15 L18.8 26.5 L15.5 15.5 Z"/>
   </svg>`,
)}`;

export default function OpengraphImage() {
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
          <div
            style={{
              display: "flex",
              fontSize: 30,
              letterSpacing: "-0.01em",
              color: C.text,
            }}
          >
            husk
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 88,
              lineHeight: 1.04,
              letterSpacing: "-0.032em",
              color: C.text,
            }}
          >
            Give your agent a computer.
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 26,
              fontSize: 30,
              lineHeight: 1.4,
              letterSpacing: "-0.005em",
              color: C.muted,
              maxWidth: 900,
            }}
          >
            A disposable Linux machine your agent can drive: shell, filesystem,
            ports. No account, no card, no telemetry.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: C.sunken,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "18px 24px",
              fontSize: 28,
              color: C.text,
            }}
          >
            <span style={{ color: C.gold, marginRight: 14 }}>$</span>
            claude mcp add husk -- npx -y @husk/mcp
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 22,
              fontSize: 22,
              color: C.subtle,
            }}
          >
            Apache-2.0 · docker, podman, local, ssh, fly · husk doctor tells you
            which one you got
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
