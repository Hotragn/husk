/**
 * The row of 3D computers in the corner of the screen: one small iMac per
 * computer, facing you, its screen showing that computer's browser.
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
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PMREMGenerator,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  Shape,
  ShapeGeometry,
  Texture,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { DeskStatus } from './bridge';
import { TINTS } from './tints';
import type { TintName } from './tints';

/** One computer's slot, in CSS pixels. Dock.tsx lays its buttons out on the same grid. */
export const SLOT_W = 88;
export const SLOT_H = 84;

export interface DockItem {
  id: string;
  status: DeskStatus;
  tint: TintName;
}

export interface DockStage {
  setItems(items: DockItem[]): void;
  setFrame(id: string, src: string): void;
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

// The iMac, in CSS pixels, around the slot's centre: a 52 x 38 display whose
// white bezel holds a 16:10 screen above a 6px coloured chin, on a blade and a foot.
const W = 52;
const H = 38;
const CHIN = 6;
const LIFT = 7; // the display's centre, above the slot's
const SCREEN_W = 48;
const SCREEN_H = 30;
/** Facing front, leaned back a little: the top edge and the foot show. Straighter on hover. */
const TILT = 0.12;
const TILT_HOVER = 0.03;
const BUILD_MS = 900;
const LEAVE_MS = 260;

interface Look {
  body: MeshPhysicalMaterial;
  chin: MeshStandardMaterial;
  wallpaper: CanvasTexture;
}

interface Model {
  id: string;
  group: Group;
  display: Group;
  blade: Mesh;
  foot: Mesh;
  screen: Mesh<PlaneGeometry, MeshBasicMaterial>;
  glow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  frame?: Texture;
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
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  scene.add(new AmbientLight(0xffffff, 0.45));
  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(-70, 140, 180);
  scene.add(key);

  const camera = new OrthographicCamera(0, 1, 1, 0, -400, 400);

  // Shared by every model: the white bezel, the shadow, the glow, the shapes.
  const bezel = new MeshStandardMaterial({ color: 0xf5f5f7, roughness: 0.32, metalness: 0 });
  const shadow = new MeshBasicMaterial({ map: radial('0,0,0', 0.5), transparent: true, depthWrite: false });
  const glowMap = radial('255,255,255', 1);
  const geo = {
    body: new RoundedBoxGeometry(W, H, 2.2, 4, 1.8),
    bezel: panel(W - 1, H - CHIN - 1, 1.4, 0),
    chin: panel(W - 1, CHIN, 0, 1.4),
    screen: new PlaneGeometry(SCREEN_W, SCREEN_H),
    blade: new BoxGeometry(12, 13, 1),
    foot: new RoundedBoxGeometry(26, 1, 15, 3, 0.5),
    shadow: new PlaneGeometry(46, 10),
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
        body: new MeshPhysicalMaterial({ color: new Color(t.back), metalness: 0.55, roughness: 0.34, clearcoat: 0.35, clearcoatRoughness: 0.3 }),
        chin: new MeshStandardMaterial({ color: new Color(t.chin), metalness: 0.15, roughness: 0.42 }),
        wallpaper: wallpaperOf(t.chin, t.back),
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
    face.position.set(0, CHIN / 2, 1.12);
    const chin = new Mesh(geo.chin, look.chin);
    chin.position.set(0, -H / 2 + 0.5 + CHIN / 2, 1.12);
    const screen = new Mesh(geo.screen, new MeshBasicMaterial({ map: look.wallpaper, transparent: true, opacity: 0, toneMapped: false }));
    screen.position.set(0, CHIN / 2, 1.16);
    display.add(body, face, chin, screen);

    // The blade runs down behind the chin to the foot, leaning back a little.
    const blade = new Mesh(geo.blade, look.body);
    blade.position.set(0, LIFT - H / 2 - 5.5, -2.4);
    blade.rotation.x = -0.2;
    const foot = new Mesh(geo.foot, look.body);
    foot.position.set(0, LIFT - H / 2 - 12.2, -2.2);
    const under = new Mesh(geo.shadow, shadow);
    under.position.set(0, LIFT - H / 2 - 13, -12);
    // Normal blending: an additive glow vanishes on a transparent canvas over the desktop.
    const glow = new Mesh(geo.glow, new MeshBasicMaterial({ map: glowMap, color: 0x000000, transparent: true, opacity: 0, depthWrite: false }));
    glow.position.set(0, LIFT, -14);

    group.add(glow, under, foot, blade, display);
    group.rotation.set(TILT, 0, 0);
    group.scale.setScalar(0.001);
    const x = slotX(index);
    group.position.set(x, SLOT_H / 2, 0);
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
    m.group.scale.setScalar(Math.max(0.001, scale));
    m.group.rotation.x = TILT + (TILT_HOVER - TILT) * m.hover;
    m.x += (slotX(m.index) - m.x) * 0.25;
    if (Math.abs(slotX(m.index) - m.x) > 0.3) moving = true;
    else m.x = slotX(m.index);
    m.group.position.set(m.x, SLOT_H / 2 + 4 * m.hover, 0);

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
        m.frame?.dispose();
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
    setFrame(id, src) {
      const img = new Image();
      img.onload = () => {
        const m = models.get(id);
        if (!m) return;
        if (!m.frame) {
          m.frame = new Texture(img);
          m.frame.colorSpace = SRGBColorSpace;
          m.screen.material.map = m.frame;
          m.screen.material.needsUpdate = true;
        } else {
          m.frame.image = img;
        }
        m.frame.needsUpdate = true;
        kick();
      };
      img.src = src;
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
        m.frame?.dispose();
      }
      models.clear();
      for (const look of looks.values()) {
        look.body.dispose();
        look.chin.dispose();
        look.wallpaper.dispose();
      }
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

/** A flat panel of the display's face, centred, with its top or bottom corners rounded. */
function panel(w: number, h: number, top: number, bottom: number): ShapeGeometry {
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
  return new ShapeGeometry(s, 6);
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

/** What a screen shows before its first frame: a wallpaper in the computer's own colour, as an iMac's is. */
function wallpaperOf(light: string, deep: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 100;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createLinearGradient(0, 0, 160, 100);
    grad.addColorStop(0, light);
    grad.addColorStop(1, deep);
    g.fillStyle = grad;
    g.fillRect(0, 0, 160, 100);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
