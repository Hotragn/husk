/**
 * The shell geometry, shared by the WebGL viewer and the static SVG fallback
 * so the two are literally the same object rather than two drawings of it.
 *
 * A regular icosahedron: 12 vertices, 20 congruent equilateral faces. Each
 * face becomes a plate. Plates move outward along their own normal by an
 * amount that encodes how much containment the selected provider actually
 * gives you — that is the only thing this object depicts.
 */

export type Vec3 = [number, number, number];

const T = (1 + Math.sqrt(5)) / 2;

const RAW_VERTICES: Vec3[] = [
  [-1, T, 0],
  [1, T, 0],
  [-1, -T, 0],
  [1, -T, 0],
  [0, -1, T],
  [0, 1, T],
  [0, -1, -T],
  [0, 1, -T],
  [T, 0, -1],
  [T, 0, 1],
  [-T, 0, -1],
  [-T, 0, 1],
];

export const FACE_INDICES: Array<[number, number, number]> = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export const VERTICES: Vec3[] = RAW_VERTICES.map(norm);

export interface Face {
  /** Unit-length outward normal. */
  normal: Vec3;
  /** Face centre, on the unit sphere's inscribed radius. */
  centroid: Vec3;
  /** Orthonormal in-plane basis; e1 points at the face's first vertex. */
  e1: Vec3;
  e2: Vec3;
  /** Distance from centroid to a vertex. Identical for all twenty faces. */
  circumradius: number;
  /**
   * A fixed per-face wobble, so an open shell looks like something that came
   * apart rather than something that was exploded by a tween. Deterministic:
   * the same twenty numbers on every render, on every machine.
   */
  jitter: number;
}

export const FACES: Face[] = FACE_INDICES.map(([a, b, c], i) => {
  const va = VERTICES[a];
  const vb = VERTICES[b];
  const vc = VERTICES[c];
  const centroid: Vec3 = [
    (va[0] + vb[0] + vc[0]) / 3,
    (va[1] + vb[1] + vc[1]) / 3,
    (va[2] + vb[2] + vc[2]) / 3,
  ];
  const normal = norm(cross(sub(vb, va), sub(vc, va)));
  const e1 = norm(sub(va, centroid));
  const e2 = cross(normal, e1);
  const circumradius = Math.hypot(
    va[0] - centroid[0],
    va[1] - centroid[1],
    va[2] - centroid[2],
  );
  // A cheap deterministic hash of the face index, in [-1, 1].
  const jitter = Math.sin(i * 12.9898) * 43758.5453;
  return {
    normal,
    centroid,
    e1,
    e2,
    circumradius,
    jitter: (jitter - Math.floor(jitter)) * 2 - 1,
  };
});

/** How far the plates sit off the closed shell, per provider shell state. */
export const SEPARATION: Record<"sealed" | "partial" | "open", number> = {
  sealed: 0,
  partial: 0.16,
  open: 0.34,
};

/** How exposed the core is. Drives the shader's rim intensity. */
export const EXPOSURE: Record<"sealed" | "partial" | "open", number> = {
  sealed: 0.12,
  partial: 0.55,
  open: 1,
};

/**
 * Plates are drawn slightly smaller than their face, so a closed shell still
 * reads as twenty pieces rather than one solid. Tight enough that "closed"
 * looks closed.
 */
export const PLATE_SCALE = 0.965;
