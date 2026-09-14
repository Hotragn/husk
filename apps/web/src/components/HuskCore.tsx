"use client";

/**
 * HuskCore — the isolation viewer.
 *
 * What it depicts
 * ---------------
 * Twenty plates of a regular icosahedron around a lit core. The plates sit
 * closed when the selected provider gives you a kernel boundary and stand off
 * it when it does not. That is the whole content: it is a reading of
 * `Availability.isolated` for the provider the reader picked, in geometry
 * instead of a badge, and it is the same object the SVG fallback draws.
 *
 * Why it does not idle-animate
 * ----------------------------
 * UI-PRINCIPLES.md §3 bans looping motion and §8.2 bans the decorative
 * rotating shape. Nothing here moves on its own. Movement happens for exactly
 * two reasons, both caused by the reader: they changed the provider (the shell
 * opens or closes and the core pulses once), or they dragged / arrow-keyed the
 * object (it rotates and settles). When everything has settled the render loop
 * is switched off — `frameloop` returns to "demand" — and the GPU does nothing
 * until the reader touches it again.
 *
 * Budget
 * ------
 * All twenty faces of an icosahedron are congruent, so the plates are one
 * geometry drawn as a single InstancedMesh. Two draw calls, ~1.4k triangles,
 * three lights, no environment map, no post-processing, DPR capped at 1.75.
 */

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { FACES, PLATE_SCALE } from "@/lib/husk-geometry";

export interface CoreColors {
  shell: string;
  coreDeep: string;
  coreLit: string;
  coreRim: string;
}

export interface HuskCoreProps {
  /** Target plate separation. 0 is a closed shell. */
  separation: number;
  /** Target core exposure, 0..1. */
  exposure: number;
  /** Target rotation in radians. */
  yaw: number;
  pitch: number;
  /** Bump this to fire the one-shot pulse: the provider changed. */
  pulseKey: number;
  /** True while the loop is allowed to run. Gated by the parent on visibility. */
  running: boolean;
  /** Called once, when everything has come to rest. */
  onSettled: () => void;
  colors: CoreColors;
}

/* -----------------------------------------------------------------------------
   Plate geometry: a triangular prism, built once, instanced twenty times.
-------------------------------------------------------------------------------- */

function buildPlateGeometry(radius: number, thickness: number) {
  const h = thickness / 2;
  const c: Array<[number, number]> = [0, 1, 2].map((k) => {
    const a = (k * 2 * Math.PI) / 3;
    return [Math.cos(a) * radius, Math.sin(a) * radius];
  });

  const verts: number[] = [];
  const push = (i: number, z: number) => verts.push(c[i][0], c[i][1], z);

  // Front cap, wound counter-clockwise seen from +Z.
  push(0, h);
  push(1, h);
  push(2, h);
  // Back cap.
  push(0, -h);
  push(2, -h);
  push(1, -h);
  // Three side quads, wound so the normal points radially outward.
  for (let k = 0; k < 3; k++) {
    const n = (k + 1) % 3;
    push(k, h);
    push(k, -h);
    push(n, -h);
    push(k, h);
    push(n, -h);
    push(n, h);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  return geo;
}

/* -----------------------------------------------------------------------------
   The core shader: fresnel rim plus two octaves of 3D simplex noise.
   Simplex after Ashima Arts / Stefan Gustavson (MIT), renamed so nothing can
   collide with the chunks three.js injects.
-------------------------------------------------------------------------------- */

const CORE_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewW;
  varying vec3 vPosL;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewW = normalize(cameraPosition - world.xyz);
    vPosL = position;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const CORE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uPulse;
  uniform float uExposure;
  uniform vec3 uDeep;
  uniform vec3 uLit;
  uniform vec3 uRim;

  varying vec3 vNormalW;
  varying vec3 vViewW;
  varying vec3 vPosL;

  vec3 hkMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 hkMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 hkPermute(vec4 x) { return hkMod289(((x * 34.0) + 1.0) * x); }
  vec4 hkTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float hkSnoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = hkMod289(i);
    vec4 p = hkPermute(hkPermute(hkPermute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = hkTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  void main() {
    float facing = clamp(dot(normalize(vNormalW), normalize(vViewW)), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 2.6);

    float n1 = hkSnoise(vPosL * 3.4 + vec3(0.0, uTime * 0.30, 0.0));
    float n2 = hkSnoise(vPosL * 8.1 - vec3(uTime * 0.18, 0.0, uTime * 0.11));
    float veins = smoothstep(-0.10, 0.62, n1 * 0.72 + n2 * 0.28);

    vec3 col = mix(uDeep, uLit, veins * (0.30 + 0.70 * uExposure));
    col += uRim * fresnel * (0.45 + 0.85 * uExposure);
    col += uLit * uPulse * (0.20 + 0.80 * fresnel);

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/* -----------------------------------------------------------------------------
   Scene
-------------------------------------------------------------------------------- */

const EPS = 0.0015;

function Scene({
  separation,
  exposure,
  yaw,
  pitch,
  pulseKey,
  onSettled,
  colors,
}: Omit<HuskCoreProps, "running">) {
  const group = useRef<THREE.Group>(null);
  const plates = useRef<THREE.InstancedMesh>(null);
  const coreMat = useRef<THREE.ShaderMaterial>(null);

  const anim = useRef({
    sep: separation,
    exp: exposure,
    yaw,
    pitch,
    pulse: 0,
    time: 0,
    settled: false,
  });

  const plateGeometry = useMemo(
    () => buildPlateGeometry(FACES[0].circumradius * PLATE_SCALE, 0.05),
    [],
  );
  const coreGeometry = useMemo(() => new THREE.IcosahedronGeometry(0.56, 3), []);

  useEffect(() => {
    return () => {
      plateGeometry.dispose();
      coreGeometry.dispose();
    };
  }, [plateGeometry, coreGeometry]);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uExposure: { value: exposure },
      uDeep: { value: new THREE.Color(colors.coreDeep) },
      uLit: { value: new THREE.Color(colors.coreLit) },
      uRim: { value: new THREE.Color(colors.coreRim) },
    }),
    // Built once. Colours are pushed imperatively below so that switching
    // theme does not recompile the program.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    uniforms.uDeep.value.set(colors.coreDeep);
    uniforms.uLit.value.set(colors.coreLit);
    uniforms.uRim.value.set(colors.coreRim);
  }, [colors, uniforms]);

  // The provider changed: fire the one-shot pulse.
  useEffect(() => {
    anim.current.pulse = 1;
    anim.current.settled = false;
  }, [pulseKey]);

  useEffect(() => {
    anim.current.settled = false;
  }, [separation, exposure, yaw, pitch]);

  const scratch = useMemo(
    () => ({
      obj: new THREE.Object3D(),
      m: new THREE.Matrix4(),
      e1: new THREE.Vector3(),
      e2: new THREE.Vector3(),
      n: new THREE.Vector3(),
      c: new THREE.Vector3(),
    }),
    [],
  );

  const writeMatrices = useMemo(() => {
    return (sep: number) => {
      const mesh = plates.current;
      if (!mesh) return;
      for (let i = 0; i < FACES.length; i++) {
        const f = FACES[i];
        const drift = sep * (1 + f.jitter * 0.35);
        scratch.e1.set(f.e1[0], f.e1[1], f.e1[2]);
        scratch.e2.set(f.e2[0], f.e2[1], f.e2[2]);
        scratch.n.set(f.normal[0], f.normal[1], f.normal[2]);
        scratch.c
          .set(f.centroid[0], f.centroid[1], f.centroid[2])
          .multiplyScalar(1 + drift);
        scratch.m.makeBasis(scratch.e1, scratch.e2, scratch.n);
        scratch.m.setPosition(scratch.c);
        scratch.obj.matrix.copy(scratch.m);
        scratch.obj.matrix.decompose(
          scratch.obj.position,
          scratch.obj.quaternion,
          scratch.obj.scale,
        );
        // A small out-of-plane tilt once a plate has left the shell, so an open
        // husk reads as something that came apart, not something scaled up.
        scratch.obj.rotateX(f.jitter * sep * 0.9);
        scratch.obj.rotateY(-f.jitter * sep * 0.6);
        scratch.obj.updateMatrix();
        mesh.setMatrixAt(i, scratch.obj.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
  }, [scratch]);

  // Place the plates before the first frame is drawn.
  useEffect(() => {
    writeMatrices(anim.current.sep);
  }, [writeMatrices]);

  useFrame((_, rawDelta) => {
    // A tab that was hidden hands back a very large delta on return. Clamp it,
    // or the object jumps.
    const delta = Math.min(rawDelta, 0.05);
    const s = anim.current;

    const ease = (cur: number, target: number, rate: number) =>
      cur + (target - cur) * (1 - Math.exp(-delta * rate));

    const prevSep = s.sep;
    s.sep = ease(s.sep, separation, 7.5);
    s.exp = ease(s.exp, exposure, 7.5);
    s.yaw = ease(s.yaw, yaw, 6.5);
    s.pitch = ease(s.pitch, pitch, 6.5);
    s.pulse *= Math.exp(-delta * 4.2);
    if (s.pulse < 0.004) s.pulse = 0;
    // The noise field only advances while the pulse is alive. It is not an
    // ambient animation.
    if (s.pulse > 0) s.time += delta;

    const done =
      Math.abs(s.sep - separation) < EPS &&
      Math.abs(s.exp - exposure) < EPS &&
      Math.abs(s.yaw - yaw) < EPS &&
      Math.abs(s.pitch - pitch) < EPS &&
      s.pulse === 0;

    if (done) {
      s.sep = separation;
      s.exp = exposure;
      s.yaw = yaw;
      s.pitch = pitch;
    }

    if (group.current) {
      group.current.rotation.y = s.yaw;
      group.current.rotation.x = s.pitch;
    }
    if (Math.abs(s.sep - prevSep) > 1e-5 || done) writeMatrices(s.sep);
    if (coreMat.current) {
      coreMat.current.uniforms.uTime.value = s.time;
      coreMat.current.uniforms.uPulse.value = s.pulse;
      coreMat.current.uniforms.uExposure.value = s.exp;
    }

    if (done && !s.settled) {
      s.settled = true;
      onSettled();
    }
  });

  return (
    <>
      <ambientLight intensity={0.9} />
      <directionalLight position={[3.5, 4.5, 5]} intensity={2.1} />
      <directionalLight position={[-4, -1.5, -2.5]} intensity={0.6} />

      <group ref={group}>
        <instancedMesh
          ref={plates}
          args={[plateGeometry, undefined, FACES.length]}
          frustumCulled={false}
        >
          <meshStandardMaterial
            color={colors.shell}
            roughness={0.62}
            metalness={0.06}
            flatShading
            side={THREE.DoubleSide}
          />
        </instancedMesh>

        <mesh geometry={coreGeometry}>
          <shaderMaterial
            ref={coreMat}
            vertexShader={CORE_VERT}
            fragmentShader={CORE_FRAG}
            uniforms={uniforms}
          />
        </mesh>
      </group>
    </>
  );
}

export default function HuskCore({ running, ...rest }: HuskCoreProps) {
  return (
    <Canvas
      frameloop={running ? "always" : "demand"}
      dpr={[1, 1.75]}
      flat
      camera={{ position: [0, 0, 4.5], fov: 34 }}
      gl={{
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      }}
      style={{ width: "100%", height: "100%" }}
    >
      <Scene {...rest} />
    </Canvas>
  );
}
