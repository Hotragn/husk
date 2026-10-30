/**
 * The hero object's layout: a chat, a computer, and the line between them.
 *
 * Shared by the WebGL scene and the SVG it falls back to, so the two are one
 * object rather than two drawings that drift apart.
 *
 * What it depicts
 * ---------------
 * The sentence next to it. "Your AI chat gets a real computer of its own" is
 * two things and a connection, so the object is two things and a connection: a
 * chat panel with a conversation in it, a machine below and behind it, and a
 * cable carrying one pulse from the chat into the machine's port, which lights
 * when it arrives.
 *
 * That is the test §8.2 of UI-PRINCIPLES sets — "it depicts nothing" is the
 * whole of the case against decorative 3D. This depicts the product's one
 * claim, and a reader who looks at it and then reads the headline should find
 * the headline already familiar.
 *
 * What it replaced, and why
 * -------------------------
 * Three earlier attempts, all of them the brand rather than the product: a
 * lathed husk (a flat blob head-on, because a surface with no wall has no
 * inside to show), the mark's own paths extruded (solid, but it was the logo,
 * which already appears three other places on the page), and a ribbed seed pod
 * with a real wall (correct, legible, and still a seed rather than a computer).
 *
 * The lesson kept from all three: build it from slabs with thickness. Anything
 * with a front face and no depth reads as a sticker.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/* -----------------------------------------------------------------------------
   The chat panel.
-------------------------------------------------------------------------------- */

export const CHAT = {
  width: 1.52,
  height: 1.08,
  depth: 0.11,
  radius: 0.1,
  /** Where it settles. */
  position: [-0.42, 0.44, 0.12] as Vec3,
  rotation: [0.08, 0.34, 0.015] as Vec3,
};

/**
 * The conversation, as bars. Four of them: two from one side, two from the
 * other, which is the least that reads as a exchange rather than a list.
 *
 * `x` and `y` are offsets from the panel's centre on its own face; `w` is the
 * bar's width. Deliberately not text — text at this size is unreadable, and
 * inventing a legible transcript here would be inventing a transcript.
 */
export interface ChatBar {
  x: number;
  y: number;
  w: number;
  h: number;
  /** true = the reader's side, drawn in the accent. */
  mine: boolean;
}

export const CHAT_BARS: ChatBar[] = [
  { x: -0.3, y: 0.3, w: 0.62, h: 0.1, mine: false },
  { x: -0.38, y: 0.14, w: 0.46, h: 0.1, mine: false },
  { x: 0.34, y: -0.05, w: 0.54, h: 0.1, mine: true },
  { x: -0.34, y: -0.24, w: 0.54, h: 0.1, mine: false },
];

/** The composer rule along the bottom of the panel. */
export const CHAT_COMPOSER = { y: -0.42, w: 1.16, h: 0.055 };

/** A title bar, so the panel reads as a window rather than a dark rectangle. */
export const CHAT_HEADER = { y: 0.45, w: 1.32, h: 0.035 };

/* -----------------------------------------------------------------------------
   The computer.
-------------------------------------------------------------------------------- */

/**
 * Chassis proportions, not parcel proportions. The first pass was 1.18 x 0.66
 * x 0.62, which is close enough to a cube that it read as a cardboard box; a
 * machine is wide, low and shallow, and the inset front plate below is what
 * stops the face looking like the side of a solid.
 */
export const MACHINE = {
  width: 1.34,
  height: 0.58,
  depth: 0.44,
  radius: 0.06,
  position: [0.52, -0.58, -0.04] as Vec3,
  rotation: [0.15, -0.4, -0.02] as Vec3,
};

/** A recessed front plate, so the face has a face. */
export const MACHINE_PLATE = { w: 1.18, h: 0.4 };

/** The lit port, and the vents ranked beside it. */
export const PORT = { x: -0.38, y: -0.02, w: 0.17, h: 0.062 };
export const VENTS = [0.06, 0.14, 0.22, 0.3, 0.38].map((x) => ({
  x,
  w: 0.022,
  h: 0.22,
}));

/* -----------------------------------------------------------------------------
   The cable.

   A quadratic bezier from the panel's lower edge to the machine's port. The
   control point sits below both so the line bows the way a cable hangs rather
   than arcing over the top like a diagram's arrow.
-------------------------------------------------------------------------------- */

export const CABLE_FROM: Vec3 = [-0.36, -0.12, 0.16];
export const CABLE_CTRL: Vec3 = [-0.05, -0.62, 0.3];
export const CABLE_TO: Vec3 = [0.3, -0.5, 0.24];
export const CABLE_RADIUS = 0.028;

export function cablePoint(t: number): Vec3 {
  const u = 1 - t;
  return [
    u * u * CABLE_FROM[0] + 2 * u * t * CABLE_CTRL[0] + t * t * CABLE_TO[0],
    u * u * CABLE_FROM[1] + 2 * u * t * CABLE_CTRL[1] + t * t * CABLE_TO[1],
    u * u * CABLE_FROM[2] + 2 * u * t * CABLE_CTRL[2] + t * t * CABLE_TO[2],
  ];
}

/* -----------------------------------------------------------------------------
   The sequence, in one place so the scene and its description agree.

   Beats are fractions of the whole, not seconds: the scene runs on a wall
   clock and reads its progress out of this table, so a throttled frame loop
   lands on the same pose as a smooth one.
-------------------------------------------------------------------------------- */

export const OPEN_SECONDS = 2.3;

export const BEATS = {
  /** The panel arrives. */
  chat: [0.0, 0.34] as Vec2,
  /** Its messages land, one after another. */
  bars: [0.12, 0.58] as Vec2,
  /** The machine slides up under it. */
  machine: [0.34, 0.72] as Vec2,
  /** The cable draws from the panel to the port. */
  cable: [0.6, 0.86] as Vec2,
  /** The pulse runs, and the port lights when it lands. */
  pulse: [0.76, 1.0] as Vec2,
};

/** Progress within a beat, 0..1, clamped. */
export function beat(p: number, span: Vec2): number {
  const [a, b] = span;
  if (p <= a) return 0;
  if (p >= b) return 1;
  return (p - a) / (b - a);
}

/** A rounded-rectangle outline, for the SVG fallback. */
export function roundedRectPath(
  cx: number,
  cy: number,
  w: number,
  h: number,
  r: number,
): string {
  const x = cx - w / 2;
  const y = cy - h / 2;
  return [
    `M${(x + r).toFixed(1)} ${y.toFixed(1)}`,
    `H${(x + w - r).toFixed(1)}`,
    `A${r} ${r} 0 0 1 ${(x + w).toFixed(1)} ${(y + r).toFixed(1)}`,
    `V${(y + h - r).toFixed(1)}`,
    `A${r} ${r} 0 0 1 ${(x + w - r).toFixed(1)} ${(y + h).toFixed(1)}`,
    `H${(x + r).toFixed(1)}`,
    `A${r} ${r} 0 0 1 ${x.toFixed(1)} ${(y + h - r).toFixed(1)}`,
    `V${(y + r).toFixed(1)}`,
    `A${r} ${r} 0 0 1 ${(x + r).toFixed(1)} ${y.toFixed(1)}`,
    "Z",
  ].join(" ");
}
