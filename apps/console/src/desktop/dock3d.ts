/**
 * The corner of the screen: one very small iMac per computer a chat is using,
 * facing you, its screen plain white. Small and still on purpose: it says a
 * computer is there, and glows only when it needs the person (waiting) or is
 * theirs (held). Clicking one opens the Computers window, where the screen is.
 *
 * Loaded on its own (Dock.tsx imports it dynamically), so three.js never
 * weighs on the console. One WebGL canvas holds every model, drawn with an
 * orthographic camera in CSS pixels, so each computer faces front wherever it
 * stands, and its slot is plain arithmetic that lines up with the buttons
 * Dock.tsx puts over it. It draws only while something moves: a computer
 * arriving, a hover, a glow that pulses. A still row costs nothing.
 * `createDockStage` throws where WebGL is not available, and Dock.tsx then
 * draws flat computers instead.
 */

import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  OrthographicCamera,
  PMREMGenerator,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  Shape,
  ShapeGeometry,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { DeskStatus } from './bridge';
import { TINTS } from './tints';
import type { TintName } from './tints';

/** One computer's slot, in CSS pixels. Dock.tsx lays its buttons out on the same grid. */
export const SLOT_W = 44;
export const SLOT_H = 46;

export interface DockItem {
  id: string;
  status: DeskStatus;
  tint: TintName;
}

export interface DockStage {
  setItems(items: DockItem[]): void;
  hover(id: string | null): void;
  dispose(): void;
}

const GLOW: Record<DeskStatus, { color: number; strength: number; pulse: boolean }> = {
  idle: { color: 0x000000, strength: 0, pulse: false },
  stopped: { color: 0x000000, strength: 0, pulse: false },
  active: { color: 0x8fb8ff, strength: 0.35, pulse: true },
  waiting: { color: 0xfbbf24, strength: 0.85, pulse: true },
  held: { color: 0x2dd4bf, strength: 0.75, pulse: false },
};

// The iMac, in CSS pixels: a 52 x 38 display, curved at the top corners and
// a little less at the bottom, whose white bezel holds a 16:10 screen above a
// 6px coloured chin, on a short blade and a small foot.
const W = 52;
const H = 38;
const CHIN = 6;
const TOP_R = 4.5;
const BOTTOM_R = 3;
const LIFT = 5; // the display's centre, above the model's
/** The model is drawn at about half size: a small mark in the corner, not a picture. */
const SIZE = 0.52;
const BASE_Y = 22; // the model's centre in its slot, from the bottom
const SCREEN_W = 45;
const SCREEN_H = 28.125;
/** The screen's centre: its top edge 2px below the display's, inside the curved corners. */
const SCREEN_Y = H / 2 - 2 - SCREEN_H / 2;
/** Facing front, leaned back a little: the top edge and the foot show. Straighter on hover. */
const TILT = 0.12;
const TILT_HOVER = 0.03;
const BUILD_MS = 900;
const LEAVE_MS = 260;

interface Look {
  body: MeshPhysicalMaterial;
  chin: MeshStandardMaterial;
}

interface Model {
  id: string;
  group: Group;
  display: Group;
  blade: Mesh;
  foot: Mesh;
  screen: Mesh<PlaneGeometry, MeshBasicMaterial>;
  glow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  born: number;
  leaving?: number;
  index: number;
  x: number;
  status: DeskStatus;
  hover: number;
  hoverTo: number;
}

export function createDockStage(canvas: HTMLCanvasElement): DockStage {
  // Throws where there is no WebGL: the caller falls back to flat computers.
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  // Neutral keeps soft colours soft, where ACES lifts pale tints to white.
  renderer.toneMapping = NeutralToneMapping;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  scene.add(new AmbientLight(0xffffff, 0.55));
  const key = new DirectionalLight(0xffffff, 1.2);
  key.position.set(-70, 140, 180);
  scene.add(key);

  const camera = new OrthographicCamera(0, 1, 1, 0, -400, 400);

  // Shared by every model: the white bezel, the shadow, the glow, the shapes.
  const bezel = new MeshStandardMaterial({ color: 0xf5f5f7, roughness: 0.32, metalness: 0 });
  const shadow = new MeshBasicMaterial({ map: radial('0,0,0', 0.5), transparent: true, depthWrite: false });
  const glowMap = radial('255,255,255', 1);
  // Every screen is white glass: no picture moves in the corner.
  const white = whiteScreen();
  const geo = {
    body: shell(),
    bezel: panel(W - 1, H - CHIN - 0.5, TOP_R - 0.5, 0),
    chin: panel(W - 1, CHIN - 0.5, 0, BOTTOM_R - 0.5),
    screen: new PlaneGeometry(SCREEN_W, SCREEN_H),
    blade: new BoxGeometry(10, 6, 0.9),
    foot: new RoundedBoxGeometry(18, 0.9, 11, 3, 0.45),
    shadow: new PlaneGeometry(38, 8),
    glow: new PlaneGeometry(82, 62),
  };

  // One look per colour, shared by every computer of that colour.
  const looks = new Map<TintName, Look>();
  const lookOf = (tint: TintName): Look => {
    let look = looks.get(tint);
    if (!look) {
      const t = TINTS[tint];
      look = {
        // Anodised aluminium: the back, the edges, the blade and the foot.
        body: new MeshPhysicalMaterial({ color: new Color(t.back), metalness: 0.3, roughness: 0.48, clearcoat: 0.25, clearcoatRoughness: 0.4 }),
        chin: new MeshStandardMaterial({ color: new Color(t.chin), metalness: 0.05, roughness: 0.5 }),
      };
      looks.set(tint, look);
    }
    return look;
  };

  const models = new Map<string, Model>();
  let hovered: string | null = null;
  let raf = 0;
  let width = 1;

  const slotX = (index: number) => width - (index + 0.5) * SLOT_W;

  function build(item: DockItem, index: number, now: number): Model {
    const look = lookOf(item.tint);
    const group = new Group();

    const display = new Group();
    display.position.set(0, LIFT, 0);
    const body = new Mesh(geo.body, look.body);
    const face = new Mesh(geo.bezel, bezel);
    face.position.set(0, (CHIN - 0.5) / 2, 1.12);
    const chin = new Mesh(geo.chin, look.chin);
    chin.position.set(0, -H / 2 + 0.5 + (CHIN - 0.5) / 2, 1.12);
    const screen = new Mesh(geo.screen, new MeshBasicMaterial({ map: white, transparent: true, opacity: 0, toneMapped: false }));
    screen.position.set(0, SCREEN_Y, 1.16);
    display.add(body, face, chin, screen);

    // A short blade runs down behind the chin to a small foot, leaning back a little.
    const blade = new Mesh(geo.blade, look.body);
    blade.position.set(0, LIFT - H / 2 - 2, -2.2);
    blade.rotation.x = -0.18;
    const foot = new Mesh(geo.foot, look.body);
    foot.position.set(0, LIFT - H / 2 - 5.3, -2);
    const under = new Mesh(geo.shadow, shadow);
    under.position.set(0, LIFT - H / 2 - 6.5, -12);
    // Normal blending: an additive glow vanishes on a transparent canvas over the desktop.
    const glow = new Mesh(geo.glow, new MeshBasicMaterial({ map: glowMap, color: 0x000000, transparent: true, opacity: 0, depthWrite: false }));
    glow.position.set(0, LIFT, -14);

    group.add(glow, under, foot, blade, display);
    group.rotation.set(TILT, 0, 0);
    group.scale.setScalar(0.001);
    const x = slotX(index);
    group.position.set(x, BASE_Y, 0);
    scene.add(group);
    return { id: item.id, group, display, blade, foot, screen, glow, born: now, index, x, status: item.status, hover: 0, hoverTo: 0 };
  }

  /** One frame of one model's animation. True while it still moves. */
  function step(m: Model, now: number): boolean {
    let moving = false;
    const age = now - m.born;
    if (age < BUILD_MS) moving = true;
    // Arriving: the foot, then the blade, then the display settles on and lights up.
    const foot = ease(clamp01(age / 260));
    const blade = ease(clamp01((age - 120) / 260));
    const drop = back(clamp01((age - 200) / 520));
    const light = clamp01((age - 380) / 420);
    m.foot.scale.set(Math.max(0.001, foot), 1, 1);
    m.blade.scale.set(1, Math.max(0.001, blade), 1);
    m.display.position.y = LIFT + (1 - drop) * 24;
    m.display.scale.setScalar(Math.max(0.001, 0.6 + 0.4 * drop));
    m.screen.material.opacity = (m.status === 'stopped' ? 0.35 : 1) * light;

    // Hover: lift a little, grow a little, sit up straighter. Always facing front.
    m.hover += (m.hoverTo - m.hover) * 0.22;
    if (Math.abs(m.hoverTo - m.hover) > 0.002) moving = true;
    else m.hover = m.hoverTo;
    let scale = 1 + 0.06 * m.hover;
    if (m.leaving !== undefined) {
      const out = clamp01((now - m.leaving) / LEAVE_MS);
      scale *= 1 - ease(out);
      moving = out < 1;
    } else {
      scale *= Math.min(1, 0.001 + ease(clamp01(age / 360)));
    }
    m.group.scale.setScalar(Math.max(0.001, scale * SIZE));
    m.group.rotation.x = TILT + (TILT_HOVER - TILT) * m.hover;
    m.x += (slotX(m.index) - m.x) * 0.25;
    if (Math.abs(slotX(m.index) - m.x) > 0.3) moving = true;
    else m.x = slotX(m.index);
    m.group.position.set(m.x, BASE_Y + 2 * m.hover, 0);

    const g = GLOW[m.status];
    const pulse = g.pulse ? 0.65 + 0.35 * Math.sin(now / 260) : 1;
    m.glow.material.color.setHex(g.color);
    m.glow.material.opacity = g.strength * pulse * light;
    if (g.pulse && g.strength > 0) moving = true;
    return moving;
  }

  function draw(now: number) {
    raf = 0;
    let moving = false;
    for (const m of [...models.values()]) {
      const still = step(m, now);
      if (m.leaving !== undefined && !still) {
        scene.remove(m.group);
        m.screen.material.dispose();
        m.glow.material.dispose();
        models.delete(m.id);
        continue;
      }
      moving = still || moving;
    }
    renderer.render(scene, camera);
    if (moving) kick();
  }

  const kick = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };

  function resize() {
    width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.left = 0;
    camera.right = width;
    camera.top = height;
    camera.bottom = 0;
    camera.updateProjectionMatrix();
    kick();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  return {
    setItems(items) {
      const now = performance.now();
      const wanted = new Set(items.map((i) => i.id));
      for (const m of models.values()) if (!wanted.has(m.id) && m.leaving === undefined) m.leaving = now;
      items.forEach((item, index) => {
        let m = models.get(item.id);
        if (!m || m.leaving !== undefined) {
          if (m) scene.remove(m.group);
          m = build(item, index, now);
          models.set(item.id, m);
        }
        m.index = index;
        m.status = item.status;
        m.hoverTo = hovered === item.id ? 1 : 0;
      });
      kick();
    },
    hover(id) {
      hovered = id;
      for (const m of models.values()) m.hoverTo = m.id === id ? 1 : 0;
      kick();
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      for (const m of models.values()) {
        m.screen.material.dispose();
        m.glow.material.dispose();
      }
      models.clear();
      for (const look of looks.values()) {
        look.body.dispose();
        look.chin.dispose();
      }
      white.dispose();
      looks.clear();
      for (const g of Object.values(geo)) g.dispose();
      bezel.dispose();
      shadow.map?.dispose();
      shadow.dispose();
      glowMap.dispose();
      scene.environment?.dispose();
      room.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}

/**
 * The display's body: a rounded rectangle, curved more at the top than the
 * bottom, extruded thin with a soft bevel on every edge. Centred on z, its
 * front face at z = 1.1, where the bezel, the chin and the screen sit.
 */
function shell(): ExtrudeGeometry {
  const bevel = 0.3;
  const body = new ExtrudeGeometry(outline(W - 2 * bevel, H - 2 * bevel, TOP_R - bevel, BOTTOM_R - bevel), {
    depth: 1.6,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 12,
  });
  body.translate(0, 0, -0.8);
  return body;
}

/** A flat panel of the display's face, centred, with its top or bottom corners rounded. */
function panel(w: number, h: number, top: number, bottom: number): ShapeGeometry {
  return new ShapeGeometry(outline(w, h, top, bottom), 12);
}

/** A centred rectangle with its top and bottom corners rounded by `top` and `bottom`. */
function outline(w: number, h: number, top: number, bottom: number): Shape {
  const x = -w / 2;
  const y = -h / 2;
  const s = new Shape();
  s.moveTo(x + bottom, y);
  s.lineTo(x + w - bottom, y);
  s.quadraticCurveTo(x + w, y, x + w, y + bottom);
  s.lineTo(x + w, y + h - top);
  s.quadraticCurveTo(x + w, y + h, x + w - top, y + h);
  s.lineTo(x + top, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - top);
  s.lineTo(x, y + bottom);
  s.quadraticCurveTo(x, y, x + bottom, y);
  return s;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function ease(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Ease out with a small overshoot: the display settles onto its stand. */
function back(t: number): number {
  const c = 1.4;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

/** A soft round spot of one colour, fading to that same colour, transparent: no grey rim. */
function radial(rgb: string, alpha: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${rgb},${alpha})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** A screen that is on and empty: white glass, a touch cooler at the bottom, with a soft sheen. */
function whiteScreen(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 100;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createLinearGradient(0, 0, 0, 100);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#eef1f5');
    g.fillStyle = grad;
    g.fillRect(0, 0, 160, 100);
    const sheen = g.createRadialGradient(38, 18, 0, 38, 18, 120);
    sheen.addColorStop(0, 'rgba(255,255,255,0.9)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.fillRect(0, 0, 160, 100);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
