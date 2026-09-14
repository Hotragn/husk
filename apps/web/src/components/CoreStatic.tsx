/**
 * The static SVG the isolation viewer degrades to when WebGL is unavailable,
 * when the browser reports prefers-reduced-motion, and while the WebGL chunk
 * is still loading.
 *
 * It is not a placeholder image. It is the same icosahedron, orthographically
 * projected here in TypeScript from the same FACES table, so it carries the
 * same information: plates apart means the core is not contained. Changing
 * provider changes this drawing instantly, with no animation — a collapsed
 * transition is not a removed state change (UI-PRINCIPLES.md §3).
 */

import { EXPOSURE, FACES, PLATE_SCALE, SEPARATION, type Vec3 } from "@/lib/husk-geometry";

type ShellState = "sealed" | "partial" | "open";

/* A fixed three-quarter view. Not animated, not interactive: this is the
   drawing you get when the machine cannot or should not animate. */
const YAW = 0.62;
const PITCH = -0.38;

function rotate(v: Vec3): Vec3 {
  const [x, y, z] = v;
  const x1 = x * Math.cos(YAW) + z * Math.sin(YAW);
  const z1 = -x * Math.sin(YAW) + z * Math.cos(YAW);
  const y2 = y * Math.cos(PITCH) - z1 * Math.sin(PITCH);
  const z2 = y * Math.sin(PITCH) + z1 * Math.cos(PITCH);
  return [x1, y2, z2];
}

const SIZE = 200;
const SCALE = 62;

function project(v: Vec3): [number, number] {
  const [x, y] = rotate(v);
  // SVG y grows downward.
  return [SIZE / 2 + x * SCALE, SIZE / 2 - y * SCALE];
}

interface Plate {
  points: string;
  depth: number;
  lit: number;
}

function plates(shell: ShellState): Plate[] {
  const sep = SEPARATION[shell];
  const out: Plate[] = [];

  for (const face of FACES) {
    const rotatedNormal = rotate(face.normal);
    // Back faces would only ever be drawn behind the core; culling them keeps
    // the SVG at ~10 paths.
    if (rotatedNormal[2] <= 0.02) continue;

    const drift = sep * (1 + face.jitter * 0.35);
    const centre: Vec3 = [
      face.centroid[0] * (1 + drift),
      face.centroid[1] * (1 + drift),
      face.centroid[2] * (1 + drift),
    ];
    const r = face.circumradius * PLATE_SCALE;

    const corners: string[] = [];
    for (let k = 0; k < 3; k++) {
      const a = (k * 2 * Math.PI) / 3;
      const p: Vec3 = [
        centre[0] + (Math.cos(a) * face.e1[0] + Math.sin(a) * face.e2[0]) * r,
        centre[1] + (Math.cos(a) * face.e1[1] + Math.sin(a) * face.e2[1]) * r,
        centre[2] + (Math.cos(a) * face.e1[2] + Math.sin(a) * face.e2[2]) * r,
      ];
      const [px, py] = project(p);
      corners.push(`${px.toFixed(2)},${py.toFixed(2)}`);
    }

    out.push({
      points: corners.join(" "),
      depth: rotate(centre)[2],
      lit: rotatedNormal[2],
    });
  }

  return out.sort((a, b) => a.depth - b.depth);
}

export function CoreStatic({
  shell = "sealed",
  className,
}: {
  shell?: ShellState;
  className?: string;
}) {
  const faces = plates(shell);
  const exposure = EXPOSURE[shell];
  const coreR = 0.56 * SCALE;

  return (
    <svg
      className={className ?? "core-svg"}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* The core. A flat bright shape next to flat dull ones — the same rule
          the mark follows. It gets brighter as the shell opens because that is
          the information: an exposed core is an uncontained one. */}
      <g opacity={0.35 + exposure * 0.65}>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={coreR}
          fill="var(--color-accent-700)"
        />
        <polygon
          points={`${SIZE / 2},${SIZE / 2 - coreR * 0.92} ${SIZE / 2 + coreR * 0.5},${SIZE / 2 + coreR * 0.2} ${SIZE / 2 + coreR * 0.12},${SIZE / 2 + coreR * 0.9} ${SIZE / 2 - coreR * 0.62},${SIZE / 2 + coreR * 0.05}`}
          fill="var(--color-accent-fill)"
        />
      </g>

      {/* The shell plates, painter-sorted back to front. */}
      {faces.map((f, i) => (
        <polygon
          key={i}
          points={f.points}
          fill="var(--color-primary-fill)"
          fillOpacity={(0.34 + f.lit * 0.62).toFixed(3)}
          stroke="var(--color-primary-500)"
          strokeWidth="0.6"
          strokeLinejoin="bevel"
        />
      ))}
    </svg>
  );
}

export default CoreStatic;
