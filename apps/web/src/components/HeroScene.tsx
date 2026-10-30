"use client";

/**
 * The hero object: a chat, a computer, and the line between them.
 *
 * What it depicts
 * ---------------
 * The headline beside it. A chat panel with an exchange in it arrives, a
 * machine slides up underneath, a cable draws between them and one pulse runs
 * down it into the machine's port, which lights when the pulse lands. That is
 * "your AI chat gets a real computer of its own", as an object.
 *
 * Budget
 * ------
 * Two extruded slabs, a 40-segment tube, eight small planes and a six-segment
 * sphere: about 1.9k triangles, four lights, one additive quad for the port's
 * glow, DPR capped at 1.75. No post-processing — an EffectComposer writes an
 * opaque frame, and this canvas has to composite over the page.
 *
 * The loop runs while this canvas is mounted, and the parent bounds that:
 * `HeroObject` unmounts the whole thing once the hero is clear of the
 * viewport, so the cost stops at the first screen and the page never holds two
 * WebGL contexts at once — the isolation viewer further down owns the other.
 *
 * `frameloop` is "always" rather than gated on a prop. The canvas is a lazy
 * chunk, and a scene that mounted while the hero was briefly out of view
 * landed in "demand" and never advanced past its first frame. Once the
 * sequence has played nothing moves but the pointer tracking, which settles.
 */

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import {
  BEATS,
  CABLE_CTRL,
  CABLE_FROM,
  CABLE_RADIUS,
  CABLE_TO,
  CHAT,
  CHAT_BARS,
  CHAT_COMPOSER,
  CHAT_HEADER,
  MACHINE,
  MACHINE_PLATE,
  OPEN_SECONDS,
  PORT,
  VENTS,
  beat,
} from "@/lib/hero-scene";

export interface SceneColors {
  /** The machine's chassis. */
  shell: string;
  /** Its shadowed side, and the chat's edge. */
  shellDeep: string;
  /** The port, the pulse, the reader's own message. */
  lit: string;
  /** Rim light. */
  rim: string;
  /** The chat panel's face. */
  panel: string;
  /** Message bars that are not the reader's. */
  bar: string;
}

export interface HeroSceneProps {
  colors: SceneColors;
  /** The ref itself, not its value — the parent mutates it on pointermove. */
  pointer: React.RefObject<{ x: number; y: number }>;
  onOpened: () => void;
  startOpen?: boolean;
}

/* -----------------------------------------------------------------------------
   A rounded slab. Both the panel and the chassis are one of these: a rounded
   rectangle extruded with a small bevel, so every edge catches the key light
   instead of going to a hard black line.
-------------------------------------------------------------------------------- */

function buildSlab(w: number, h: number, d: number, r: number) {
  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);

  const bevel = Math.min(0.022, d / 4);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.translate(0, 0, -d / 2);
  geo.computeVertexNormals();
  return geo;
}

function buildCable() {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(...CABLE_FROM),
    new THREE.Vector3(...CABLE_CTRL),
    new THREE.Vector3(...CABLE_TO),
  );
  return { curve, geo: new THREE.TubeGeometry(curve, 40, CABLE_RADIUS, 8, false) };
}

/* The port's glow. One additive quad with a radial falloff — the part of a
   bloom pass that actually reads, at none of its cost and without the opaque
   frame an EffectComposer would put behind this canvas. */
const GLOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = (exp(-d * 6.0) + exp(-d * 2.2) * 0.3) * uStrength;
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c = 1.1;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

function Scene({ colors, pointer, onOpened, startOpen }: HeroSceneProps) {
  const root = useRef<THREE.Group>(null);
  const chatRef = useRef<THREE.Group>(null);
  const machineRef = useRef<THREE.Group>(null);
  const cableRef = useRef<THREE.Mesh>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
  const portRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const glowMat = useRef<THREE.ShaderMaterial>(null);
  const barRefs = useRef<Array<THREE.Mesh | null>>([]);
  const invalidate = useThree((s) => s.invalidate);

  const anim = useRef({
    /* null until the first frame, so the clock starts when the scene actually
       begins drawing rather than when the module evaluated. Wall clock, not
       accumulated deltas: an accumulator only reaches its end if every frame
       is delivered, and a throttled loop left the old scene stuck part-open. */
    startedAt: startOpen ? 0 : (null as number | null),
    yaw: 0,
    pitch: 0,
    announced: false,
  });

  const geo = useMemo(
    () => ({
      chat: buildSlab(CHAT.width, CHAT.height, CHAT.depth, CHAT.radius),
      machine: buildSlab(MACHINE.width, MACHINE.height, MACHINE.depth, MACHINE.radius),
      ...buildCable(),
    }),
    [],
  );

  const glowUniforms = useMemo(
    () => ({ uColor: { value: new THREE.Color(colors.lit) }, uStrength: { value: 0 } }),
    // Built once; the colour is pushed imperatively so a theme change does not
    // recompile the program.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    glowUniforms.uColor.value.set(colors.lit);
  }, [colors, glowUniforms]);

  useEffect(() => {
    const g = geo;
    return () => {
      g.chat.dispose();
      g.machine.dispose();
      g.geo.dispose();
    };
  }, [geo]);

  useFrame(() => {
    const a = anim.current;
    if (a.startedAt === null) a.startedAt = performance.now();
    const p = Math.min((performance.now() - a.startedAt) / (OPEN_SECONDS * 1000), 1);

    if (p < 1) {
      invalidate();
    } else if (!a.announced) {
      a.announced = true;
      onOpened();
    }

    // --- the chat arrives ----------------------------------------------------
    const chatIn = easeOutBack(beat(p, BEATS.chat));
    const chat = chatRef.current;
    if (chat) {
      chat.position.set(
        CHAT.position[0],
        CHAT.position[1] + (1 - chatIn) * 0.32,
        CHAT.position[2] - (1 - chatIn) * 0.5,
      );
      chat.scale.setScalar(0.86 + 0.14 * chatIn);
      chat.visible = chatIn > 0.001;
    }

    // --- its messages land, one after another --------------------------------
    const barsIn = beat(p, BEATS.bars);
    CHAT_BARS.forEach((_, i) => {
      const m = barRefs.current[i];
      if (!m) return;
      const share = 1 / CHAT_BARS.length;
      const local = easeOut(Math.max(0, Math.min((barsIn - i * share * 0.8) / share, 1)));
      m.scale.x = 0.02 + 0.98 * local;
      m.visible = local > 0.01;
    });

    // --- the machine slides up under it --------------------------------------
    const machineIn = easeOutBack(beat(p, BEATS.machine));
    const machine = machineRef.current;
    if (machine) {
      machine.position.set(
        MACHINE.position[0] + (1 - machineIn) * 0.26,
        MACHINE.position[1] - (1 - machineIn) * 0.44,
        MACHINE.position[2],
      );
      machine.scale.setScalar(0.9 + 0.1 * machineIn);
      machine.visible = machineIn > 0.001;
    }

    // --- the cable draws -----------------------------------------------------
    const cableIn = easeOut(beat(p, BEATS.cable));
    if (cableRef.current) {
      /* Drawn by revealing the tube along its own length: the geometry's draw
         range is in index space, so this is one integer per frame rather than
         a rebuilt mesh. */
      const total = geo.geo.index ? geo.geo.index.count : 0;
      geo.geo.setDrawRange(0, Math.floor(total * cableIn));
      cableRef.current.visible = cableIn > 0.01;
    }

    // --- one pulse runs down it, and the port lights when it lands -----------
    const pulseIn = beat(p, BEATS.pulse);
    const pulse = pulseRef.current;
    if (pulse) {
      const at = geo.curve.getPointAt(Math.min(pulseIn, 1));
      pulse.position.copy(at);
      // It is a pulse, not a pet: it exists while it travels and then stops.
      pulse.visible = pulseIn > 0.01 && pulseIn < 0.995;
      pulse.scale.setScalar(0.6 + 0.4 * Math.sin(Math.min(pulseIn, 1) * Math.PI));
    }

    const lit = easeOut(Math.max(0, (pulseIn - 0.75) / 0.25));
    if (portRef.current) {
      const mat = portRef.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.1 + 0.95 * lit;
    }
    if (glowMat.current) glowMat.current.uniforms.uStrength.value = lit * 0.5;
    if (glowRef.current) glowRef.current.visible = lit > 0.01;

    // --- bounded pointer tracking -------------------------------------------
    // Six degrees each way: enough to feel awake, nowhere near the free spin
    // section 8.2 of UI-PRINCIPLES is about.
    const wantYaw = pointer.current.x * 0.1;
    const wantPitch = -pointer.current.y * 0.065;
    const k = 0.08;
    a.yaw += (wantYaw - a.yaw) * k;
    a.pitch += (wantPitch - a.pitch) * k;
    if (root.current) {
      root.current.rotation.y = a.yaw;
      root.current.rotation.x = a.pitch;
    }
    if (Math.abs(wantYaw - a.yaw) > 0.0004 || Math.abs(wantPitch - a.pitch) > 0.0004) {
      invalidate();
    }
  });

  return (
    <>
      <ambientLight intensity={0.62} />
      <directionalLight position={[3.4, 4.0, 4.4]} intensity={1.85} />
      {/* The rim. Behind and below, so both slabs separate from the page
          instead of needing a stroke drawn round them. */}
      <directionalLight position={[-3.8, 0.8, -3.6]} intensity={1.15} color={colors.rim} />
      <directionalLight position={[0, -3.2, 1.6]} intensity={0.35} />

      <group ref={root}>
        {/* ---- the chat ---------------------------------------------------- */}
        <group ref={chatRef} position={CHAT.position} rotation={CHAT.rotation}>
          <mesh geometry={geo.chat}>
            <meshStandardMaterial color={colors.panel} roughness={0.52} metalness={0.05} />
          </mesh>

          {CHAT_BARS.map((b, i) => (
            <mesh
              key={i}
              ref={(el) => {
                barRefs.current[i] = el;
              }}
              position={[b.x, b.y, CHAT.depth / 2 + 0.004]}
            >
              <planeGeometry args={[b.w, b.h]} />
              <meshBasicMaterial
                color={b.mine ? colors.lit : colors.bar}
                transparent
                opacity={b.mine ? 0.85 : 0.45}
                toneMapped={false}
              />
            </mesh>
          ))}

          {/* A title bar at the top and a composer at the foot: between them
              they say this is a window someone is talking in, rather than a
              dark rectangle with stripes on it. */}
          <mesh position={[0, CHAT_HEADER.y, CHAT.depth / 2 + 0.004]}>
            <planeGeometry args={[CHAT_HEADER.w, CHAT_HEADER.h]} />
            <meshBasicMaterial color={colors.bar} transparent opacity={0.3} />
          </mesh>

          <mesh position={[0, CHAT_COMPOSER.y, CHAT.depth / 2 + 0.004]}>
            <planeGeometry args={[CHAT_COMPOSER.w, CHAT_COMPOSER.h]} />
            <meshBasicMaterial color={colors.bar} transparent opacity={0.22} />
          </mesh>
        </group>

        {/* ---- the computer ------------------------------------------------ */}
        <group ref={machineRef} position={MACHINE.position} rotation={MACHINE.rotation}>
          <mesh geometry={geo.machine}>
            <meshStandardMaterial color={colors.shell} roughness={0.46} metalness={0.16} />
          </mesh>

          {/* The recessed plate. Sitting a hair proud of the chassis and a
              shade darker is what makes the front read as a front. */}
          <mesh position={[0, 0, MACHINE.depth / 2 + 0.002]}>
            <planeGeometry args={[MACHINE_PLATE.w, MACHINE_PLATE.h]} />
            <meshBasicMaterial color={colors.shellDeep} transparent opacity={0.42} />
          </mesh>

          <mesh ref={portRef} position={[PORT.x, PORT.y, MACHINE.depth / 2 + 0.006]}>
            <planeGeometry args={[PORT.w, PORT.h]} />
            <meshStandardMaterial
              color={colors.lit}
              emissive={colors.lit}
              emissiveIntensity={0.1}
              roughness={0.3}
              toneMapped={false}
            />
          </mesh>

          <mesh ref={glowRef} position={[PORT.x, PORT.y, MACHINE.depth / 2 + 0.03]}>
            <planeGeometry args={[1.0, 1.0]} />
            <shaderMaterial
              ref={glowMat}
              transparent
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              uniforms={glowUniforms}
              vertexShader={GLOW_VERT}
              fragmentShader={GLOW_FRAG}
            />
          </mesh>

          {VENTS.map((v, i) => (
            <mesh key={i} position={[v.x, PORT.y, MACHINE.depth / 2 + 0.006]}>
              <planeGeometry args={[v.w, v.h]} />
              <meshBasicMaterial color={colors.shellDeep} transparent opacity={0.7} />
            </mesh>
          ))}
        </group>

        {/* ---- the line between them --------------------------------------- */}
        <mesh ref={cableRef} geometry={geo.geo}>
          <meshStandardMaterial
            color={colors.lit}
            emissive={colors.lit}
            emissiveIntensity={0.35}
            roughness={0.4}
            toneMapped={false}
          />
        </mesh>

        <mesh ref={pulseRef}>
          <sphereGeometry args={[0.062, 10, 6]} />
          <meshBasicMaterial color={colors.rim} toneMapped={false} />
        </mesh>
      </group>
    </>
  );
}

export default function HeroScene(props: HeroSceneProps) {
  return (
    <Canvas
      frameloop="always"
      dpr={[1, 1.75]}
      camera={{ position: [0, 0, 4.15], fov: 33 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      style={{ width: "100%", height: "100%" }}
    >
      <Scene {...props} />
    </Canvas>
  );
}
