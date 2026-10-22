/**
 * The row of 3D computers in the corner of the screen: one small, lit display
 * per computer, its screen showing that computer's browser.
 *
 * Loaded on its own (Dock.tsx imports it dynamically), so three.js never
 * weighs on the console. One WebGL canvas holds every model, drawn with an
 * orthographic camera in CSS pixels, so a model's slot is plain arithmetic
 * and lines up with the buttons Dock.tsx puts over it. It draws only while
 * something moves: a computer arriving, a hover, a glow that pulses. A still
 * row costs nothing. `createDockStage` throws where WebGL is not available,
 * and Dock.tsx then draws flat computers instead.
 */

import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  OrthographicCamera,
  PMREMGenerator,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  Texture,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { DeskStatus } from './bridge';

/** One computer's slot, in CSS pixels. Dock.tsx lays its buttons out on the same grid. */
export const SLOT_W = 88;
export const SLOT_H = 84;

export interface DockItem {
  id: string;
  status: DeskStatus;
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
  active: { color: 0x8fb8ff, strength: 0.22, pulse: true },
  waiting: { color: 0xfbbf24, strength: 0.55, pulse: true },
  held: { color: 0x2dd4bf, strength: 0.5, pulse: false },
};

const BUILD_MS = 900;
const LEAVE_MS = 260;

interface Model {
  id: string;
  group: Group;
  display: Mesh;
  neck: Mesh;
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

export function createDockStage(canvas: HTMLCanvasElement, dark: boolean): DockStage {
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
  scene.add(new AmbientLight(0xffffff, 0.35));
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(-60, 120, 160);
  scene.add(key);

  const camera = new OrthographicCamera(0, 1, 1, 0, -400, 400);

  // Shared by every model: an aluminium shell, a black bezel, a soft shadow.
  const shell = new MeshPhysicalMaterial({
    color: dark ? 0x2c2d31 : 0xd9dbe0,
    metalness: 0.92,
    roughness: 0.3,
    clearcoat: 0.6,
    clearcoatRoughness: 0.22,
  });
  const bezel = new MeshBasicMaterial({ color: 0x050506 });
  const shadow = new MeshBasicMaterial({ map: radial('rgba(0,0,0,0.55)'), transparent: true, depthWrite: false });
  const wallpaper = gradientWallpaper();
  const geo = {
    display: new RoundedBoxGeometry(58, 38, 3, 4, 1.6),
    bezel: new PlaneGeometry(56, 36),
    screen: new PlaneGeometry(53, 33),
    neck: new BoxGeometry(11, 15, 2.2),
    foot: new RoundedBoxGeometry(26, 1.8, 15, 3, 0.9),
    shadow: new PlaneGeometry(52, 12),
    glow: new PlaneGeometry(86, 64),
  };
  const glowMap = radial('rgba(255,255,255,1)');

  const models = new Map<string, Model>();
  let hovered: string | null = null;
  let raf = 0;
  let width = 1;
  let height = 1;

  function build(id: string, index: number, now: number): Model {
    const group = new Group();
    const display = new Mesh(geo.display, shell);
    display.position.set(0, 8, 0);
    const face = new Mesh(geo.bezel, bezel);
    face.position.set(0, 0, 1.52);
    const screen = new Mesh(geo.screen, new MeshBasicMaterial({ map: wallpaper, transparent: true, opacity: 0, toneMapped: false }));
    screen.position.set(0, 0, 1.56);
    display.add(face, screen);
    const neck = new Mesh(geo.neck, shell);
    neck.position.set(0, -16, -2.6);
    neck.rotation.x = -0.12;
    const foot = new Mesh(geo.foot, shell);
    foot.position.set(0, -23.5, -1);
    const under = new Mesh(geo.shadow, shadow);
    under.position.set(0, -25.5, -12);
    const glow = new Mesh(geo.glow, new MeshBasicMaterial({ map: glowMap, color: 0x000000, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    glow.position.set(0, 8, -14);
    group.add(glow, under, foot, neck, display);
    group.rotation.set(0.14, -0.42, 0);
    group.scale.setScalar(0.001);
    scene.add(group);
    const x = slotX(index);
    group.position.set(x, SLOT_H / 2 + 6, 0);
    return { id, group, display, neck, foot, screen, glow, born: now, index, x, status: 'idle', hover: 0, hoverTo: 0 };
  }

  const slotX = (index: number) => width - (index + 0.5) * SLOT_W;

  /** One frame of one model's animation. True while it still moves. */
  function step(m: Model, now: number): boolean {
    let moving = false;
    const age = now - m.born;
    if (age < BUILD_MS) moving = true;
    // Arriving: the foot, then the neck, then the display drops in and lights up.
    const foot = ease(clamp01(age / 260));
    const neck = ease(clamp01((age - 120) / 260));
    const drop = back(clamp01((age - 200) / 520));
    const light = clamp01((age - 380) / 420);
    m.foot.scale.set(1, Math.max(0.001, foot), 1);
    m.neck.scale.set(1, Math.max(0.001, neck), 1);
    m.display.position.y = 8 + (1 - drop) * 26;
    m.display.scale.setScalar(Math.max(0.001, 0.6 + 0.4 * drop));
    m.screen.material.opacity = (m.status === 'stopped' ? 0.35 : 1) * light;

    // Hover: lift, grow a little, turn to face the person.
    m.hover += (m.hoverTo - m.hover) * 0.22;
    if (Math.abs(m.hoverTo - m.hover) > 0.002) moving = true;
    else m.hover = m.hoverTo;
    let scale = 1 + 0.08 * m.hover;
    if (m.leaving !== undefined) {
      const out = clamp01((now - m.leaving) / LEAVE_MS);
      scale *= 1 - ease(out);
      moving = out < 1;
    } else {
      scale *= Math.min(1, 0.001 + ease(clamp01(age / 360)));
    }
    m.group.scale.setScalar(Math.max(0.001, scale));
    m.group.rotation.y = -0.42 + 0.3 * m.hover;
    m.x += (slotX(m.index) - m.x) * 0.25;
    if (Math.abs(slotX(m.index) - m.x) > 0.3) moving = true;
    else m.x = slotX(m.index);
    m.group.position.set(m.x, SLOT_H / 2 + 6 + 5 * m.hover, 0);

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
    height = Math.max(1, canvas.clientHeight);
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
          m = build(item.id, index, now);
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
      for (const g of Object.values(geo)) g.dispose();
      shell.dispose();
      bezel.dispose();
      shadow.map?.dispose();
      shadow.dispose();
      glowMap.dispose();
      wallpaper.dispose();
      scene.environment?.dispose();
      room.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
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

function radial(inner: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** What a screen shows before its first frame: a calm gradient, like a desktop with no windows. */
function gradientWallpaper(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 100;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createLinearGradient(0, 0, 160, 100);
    grad.addColorStop(0, '#1d2a5b');
    grad.addColorStop(0.55, '#3b2f7a');
    grad.addColorStop(1, '#0f766e');
    g.fillStyle = grad;
    g.fillRect(0, 0, 160, 100);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
