"use client";

/**
 * The gate in front of the hero's WebGL scene.
 *
 * Four things happen here and none of them in `HeroScene` itself, so that the
 * scene file is only ever about the scene:
 *
 *   1. `prefers-reduced-motion` is read before anything is imported. An
 *      entrance is decoration, not a state change, so it is removed rather
 *      than collapsed — and the chunk is never fetched, which is the part a
 *      1ms duration would not have given back.
 *   2. The chunk is `next/dynamic` with `ssr: false`, behind an
 *      IntersectionObserver, so nothing WebGL-shaped is parsed until the hero
 *      is near the viewport.
 *   3. The canvas is *unmounted* when the hero leaves, not just paused. The
 *      isolation viewer further down the page owns a context of its own, and
 *      two live contexts on one document is how a laptop fan starts.
 *   4. The static SVG holds the box at every moment the canvas does not, at
 *      the same aspect ratio, so the column never shifts.
 *
 * Colours are read from the resolved tokens rather than passed as literals,
 * which is what keeps the object on-theme through the theme toggle without a
 * second palette living in TypeScript.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { HeroSceneStatic } from "@/components/HeroSceneStatic";
import type { SceneColors } from "@/components/HeroScene";

const HeroScene = dynamic(() => import("@/components/HeroScene"), {
  ssr: false,
  loading: () => <HeroSceneStatic />,
});

const FALLBACK: SceneColors = {
  shell: "#deb076",
  shellDeep: "#a97c46",
  lit: "#42d0cf",
  rim: "#8be9e7",
  panel: "#1b1611",
  bar: "#bdb8b1",
};

/**
 * `theme` is not read in the body -- getComputedStyle already reflects it. It
 * is a parameter so the memo below has a dependency it genuinely uses, rather
 * than a correct dependency array with a lint suppression stapled to it.
 */
function readColors(theme: string): SceneColors {
  if (typeof window === "undefined" || theme === undefined) return FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const v = cs.getPropertyValue(name).trim();
    return v.length > 0 ? v : fallback;
  };
  return {
    shell: read("--color-primary-300", FALLBACK.shell),
    shellDeep: read("--color-primary-700", FALLBACK.shellDeep),
    lit: read("--color-accent-300", FALLBACK.lit),
    rim: read("--color-accent-200", FALLBACK.rim),
    panel: read("--color-surface", FALLBACK.panel),
    bar: read("--color-text-muted", FALLBACK.bar),
  };
}

/* -----------------------------------------------------------------------------
   Two external things this component reads: whether the reader asked for less
   motion, and which theme is on. Both are subscriptions to the document rather
   than component state, so both go through useSyncExternalStore -- setting
   state from an effect to mirror an external value is a cascading render, and
   the server snapshot is what keeps hydration honest.
-------------------------------------------------------------------------------- */

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const reducedSnapshot = () => window.matchMedia(REDUCED_QUERY).matches;
/* The server cannot know, and guessing "reduce" would ship the static SVG to
   everyone. It is false here and corrected on the client before the observer
   is built, which is before any chunk is requested. */
const reducedServerSnapshot = () => false;

function subscribeTheme(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}
const themeSnapshot = () => document.documentElement.getAttribute("data-theme") ?? "auto";
const themeServerSnapshot = () => "auto";

/** The description a screen reader gets instead of the object. */
const LABEL =
  "An AI chat panel with a short exchange in it, wired by a cable to a small computer below, whose port is lit.";

export function HeroObject() {
  const box = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [opened, setOpened] = useState(false);
  const pointer = useRef({ x: 0, y: 0 });

  const reduced = useSyncExternalStore(
    subscribeReduced,
    reducedSnapshot,
    reducedServerSnapshot,
  );
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot, themeServerSnapshot);
  const colors = useMemo<SceneColors>(() => readColors(theme), [theme]);

  useEffect(() => {
    if (reduced) return;
    const el = box.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
        if (entry.isIntersecting) setMounted(true);
      },
      { rootMargin: "200px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [reduced]);

  /* Unmount once the hero is well clear, so only one WebGL context is ever
     live. `mounted` going false is what actually frees it. */
  useEffect(() => {
    if (visible || !mounted) return;
    const id = window.setTimeout(() => setMounted(false), 400);
    return () => window.clearTimeout(id);
  }, [visible, mounted]);

  /* Mutated in place, never reassigned. `HeroScene` is handed this object once
     and reads it inside useFrame; a fresh object on every pointermove would
     leave the scene holding the first one forever. */
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    pointer.current.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.current.y = ((e.clientY - r.top) / r.height) * 2 - 1;
  }, []);

  const onPointerLeave = useCallback(() => {
    pointer.current.x = 0;
    pointer.current.y = 0;
  }, []);

  const onOpened = useCallback(() => setOpened(true), []);

  return (
    <div
      ref={box}
      className="hero-object"
      data-opened={opened || reduced ? "true" : "false"}
      onPointerMove={reduced ? undefined : onPointerMove}
      onPointerLeave={reduced ? undefined : onPointerLeave}
    >
      {/* The object's meaning, for anyone not receiving it as pixels. Kept
          outside the conditional so it is in the DOM whichever branch renders. */}
      <p className="visually-hidden">{LABEL}</p>

      {reduced || !mounted ? (
        <HeroSceneStatic />
      ) : (
        <HeroScene colors={colors} pointer={pointer} onOpened={onOpened} />
      )}
    </div>
  );
}

export default HeroObject;
