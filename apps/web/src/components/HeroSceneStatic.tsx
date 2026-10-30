/**
 * The drawing the hero object degrades to: no WebGL, `prefers-reduced-motion`,
 * and the frames before the WebGL chunk lands.
 *
 * Not a placeholder. It is the same chat, the same machine and the same cable
 * from the same `lib/hero-scene.ts` tables, in the settled pose the animated
 * version arrives at — so a reader who will never see the sequence still gets
 * the object the sequence exists to arrive at, and the same claim with it.
 *
 * Each slab is drawn twice, the lower copy offset down-left where the scene's
 * key light puts the shadow side. That is the whole of the depth here, and it
 * is enough: the shapes carry the meaning and the shading only says which is
 * in front.
 *
 * It renders on the server, so it is also what a crawler sees, and it holds
 * the same square box as the canvas so nothing shifts when the scene arrives.
 */

import {
  CHAT,
  CHAT_BARS,
  CHAT_COMPOSER,
  CHAT_HEADER,
  MACHINE,
  MACHINE_PLATE,
  PORT,
  VENTS,
  cablePoint,
  roundedRectPath,
} from "@/lib/hero-scene";

const SIZE = 420;
const SCALE = 150;
/* Where the key light puts the shadow side. */
const DX = -6;
const DY = 7;

/** Scene units to SVG units. y grows down in SVG. */
const px = (x: number) => SIZE / 2 + x * SCALE;
const py = (y: number) => SIZE / 2 - y * SCALE;

function slab(cx: number, cy: number, w: number, h: number, r: number, dx = 0, dy = 0) {
  return roundedRectPath(px(cx) + dx, py(cy) + dy, w * SCALE, h * SCALE, r * SCALE);
}

function cablePath(): string {
  const steps = 24;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const [x, y] = cablePoint(i / steps);
    pts.push(`${i === 0 ? "M" : "L"}${px(x).toFixed(1)} ${py(y).toFixed(1)}`);
  }
  return pts.join(" ");
}

export function HeroSceneStatic({ label }: { label?: string }) {
  const [cx, cy] = CHAT.position;
  const [mx, my] = MACHINE.position;

  return (
    <svg
      className="hero-scene-svg"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role={label ? "img" : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      focusable="false"
    >
      {label ? <title>{label}</title> : null}

      {/* The cable runs behind both slabs. */}
      <path className="hs-cable" d={cablePath()} />

      {/* The machine, back and below. */}
      <path
        className="hs-depth"
        d={slab(mx, my, MACHINE.width, MACHINE.height, MACHINE.radius, DX, DY)}
      />
      <path
        className="hs-machine"
        d={slab(mx, my, MACHINE.width, MACHINE.height, MACHINE.radius)}
      />
      <rect
        className="hs-plate"
        x={px(mx) - (MACHINE_PLATE.w * SCALE) / 2}
        y={py(my) - (MACHINE_PLATE.h * SCALE) / 2}
        width={MACHINE_PLATE.w * SCALE}
        height={MACHINE_PLATE.h * SCALE}
        rx="4"
      />
      {VENTS.map((v, i) => (
        <rect
          key={i}
          className="hs-vent"
          x={px(mx + v.x) - (v.w * SCALE) / 2}
          y={py(my + PORT.y) - (v.h * SCALE) / 2}
          width={v.w * SCALE}
          height={v.h * SCALE}
          rx="2"
        />
      ))}
      <rect
        className="hs-port"
        x={px(mx + PORT.x) - (PORT.w * SCALE) / 2}
        y={py(my + PORT.y) - (PORT.h * SCALE) / 2}
        width={PORT.w * SCALE}
        height={PORT.h * SCALE}
        rx="3"
      />

      {/* The chat, front and above. */}
      <path
        className="hs-depth"
        d={slab(cx, cy, CHAT.width, CHAT.height, CHAT.radius, DX, DY)}
      />
      <path className="hs-panel" d={slab(cx, cy, CHAT.width, CHAT.height, CHAT.radius)} />
      <rect
        className="hs-header"
        x={px(cx) - (CHAT_HEADER.w * SCALE) / 2}
        y={py(cy + CHAT_HEADER.y) - (CHAT_HEADER.h * SCALE) / 2}
        width={CHAT_HEADER.w * SCALE}
        height={CHAT_HEADER.h * SCALE}
        rx="2"
      />
      {CHAT_BARS.map((b, i) => (
        <rect
          key={i}
          className={b.mine ? "hs-bar hs-bar-mine" : "hs-bar"}
          x={px(cx + b.x) - (b.w * SCALE) / 2}
          y={py(cy + b.y) - (b.h * SCALE) / 2}
          width={b.w * SCALE}
          height={b.h * SCALE}
          rx={(b.h * SCALE) / 2}
        />
      ))}
      <rect
        className="hs-composer"
        x={px(cx) - (CHAT_COMPOSER.w * SCALE) / 2}
        y={py(cy + CHAT_COMPOSER.y) - (CHAT_COMPOSER.h * SCALE) / 2}
        width={CHAT_COMPOSER.w * SCALE}
        height={CHAT_COMPOSER.h * SCALE}
        rx="3"
      />
    </svg>
  );
}

export default HeroSceneStatic;
