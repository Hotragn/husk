"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CoreStatic } from "@/components/CoreStatic";
import type { CoreColors } from "@/components/HuskCore";
import { EXPOSURE, SEPARATION } from "@/lib/husk-geometry";
import { PROVIDERS, type Provider } from "@/lib/content";

/**
 * The hero object, and the page's honesty device.
 *
 * The reader picks a provider; the shell shows how much containment that
 * provider actually gives them, and the readout underneath says it in words.
 * Colour is never the only channel: there is a glyph, a word and a shape.
 *
 * Loading: the WebGL chunk is lazy, ssr:false, and its placeholder is the same
 * SVG drawn into the same fixed box, so nothing shifts when it arrives.
 * Degrading: no WebGL, or prefers-reduced-motion, and the SVG stays for good.
 * Pausing: the render loop only runs while something the reader started is
 * still moving, and only while the object is on screen and the tab is visible.
 */

const HuskCore = dynamic(() => import("@/components/HuskCore"), {
  ssr: false,
  loading: () => <CoreStatic shell="sealed" />,
});

const FALLBACK_COLORS: CoreColors = {
  shell: "#deb076",
  coreDeep: "#005251",
  coreLit: "#42d0cf",
  coreRim: "#8be9e7",
};

function readTokenColors(): CoreColors {
  if (typeof window === "undefined") return FALLBACK_COLORS;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    shell: read("--color-primary-fill", FALLBACK_COLORS.shell),
    coreDeep: read("--color-accent-700", FALLBACK_COLORS.coreDeep),
    coreLit: read("--color-accent-fill", FALLBACK_COLORS.coreLit),
    coreRim: read("--color-accent-200", FALLBACK_COLORS.coreRim),
  };
}

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

const PITCH_LIMIT = 0.62;

export function IsolationViewer() {
  const [providerId, setProviderId] = useState<string>("docker");
  const [mode, setMode] = useState<"static" | "gl">("static");
  const [running, setRunning] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  const [colors, setColors] = useState<CoreColors>(FALLBACK_COLORS);
  const [yaw, setYaw] = useState(0.62);
  const [pitch, setPitch] = useState(-0.3);
  const [pulseKey, setPulseKey] = useState(0);

  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  const provider: Provider = useMemo(
    () => PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0],
    [providerId],
  );

  /* -- capability: decided after mount, so the server and the first client
        render agree and there is no hydration mismatch ----------------------- */
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const decide = () => setMode(!reduced.matches && hasWebGL() ? "gl" : "static");
    decide();
    reduced.addEventListener("change", decide);
    return () => reduced.removeEventListener("change", decide);
  }, []);

  /* -- colours come from the tokens, and follow a theme change ---------------- */
  useEffect(() => {
    const sync = () => setColors(readTokenColors());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: light)");
    scheme.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      scheme.removeEventListener("change", sync);
    };
  }, []);

  /* -- pause when off screen or in a hidden tab ------------------------------- */
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setOnScreen(entry.isIntersecting),
      { rootMargin: "120px" },
    );
    io.observe(el);
    const onVisibility = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const wake = useCallback(() => setRunning(true), []);
  const onSettled = useCallback(() => setRunning(false), []);

  const choose = useCallback(
    (id: string) => {
      if (id === providerId) return;
      setProviderId(id);
      setPulseKey((k) => k + 1);
      wake();
    },
    [providerId, wake],
  );

  /* -- pointer drag ----------------------------------------------------------- */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== "gl" || e.pointerType === "touch") return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    setYaw((y) => y + dx * 0.008);
    setPitch((p) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p - dy * 0.006)));
    wake();
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  /* -- keyboard: the same rotation, without a pointer ------------------------- */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (mode !== "gl") return;
    const step = 0.22;
    switch (e.key) {
      case "ArrowLeft":
        setYaw((y) => y - step);
        break;
      case "ArrowRight":
        setYaw((y) => y + step);
        break;
      case "ArrowUp":
        setPitch((p) => Math.max(-PITCH_LIMIT, p - step));
        break;
      case "ArrowDown":
        setPitch((p) => Math.min(PITCH_LIMIT, p + step));
        break;
      case "Home":
        setYaw(0.62);
        setPitch(-0.3);
        break;
      default:
        return;
    }
    e.preventDefault();
    wake();
  };

  const label = `Husk shell, ${provider.id} provider. Isolation: ${provider.isolation}.`;

  return (
    <section aria-label="Isolation by provider">
      <div className="frame">
        <div
          ref={stage}
          className="core-stage"
          role="img"
          aria-label={label}
          aria-describedby={mode === "gl" ? "iso-keys" : undefined}
          tabIndex={mode === "gl" ? 0 : -1}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          style={{ cursor: mode === "gl" ? "grab" : "default" }}
        >
          {mode === "gl" ? (
            <HuskCore
              separation={SEPARATION[provider.shell]}
              exposure={EXPOSURE[provider.shell]}
              yaw={yaw}
              pitch={pitch}
              pulseKey={pulseKey}
              running={running && onScreen && tabVisible}
              onSettled={onSettled}
              colors={colors}
            />
          ) : (
            <CoreStatic shell={provider.shell} />
          )}
        </div>

        {/* The readout is the actual claim. The object above restates it; the
            information never lives in the picture alone. */}
        <dl className="core-readout" aria-live="polite">
          <div className="core-readout-row">
            <dt className="core-readout-label">provider</dt>
            <dd>{provider.id}</dd>
          </div>
          <div className="core-readout-row">
            <dt className="core-readout-label">isolation</dt>
            <dd className={`iso iso-${provider.isolationKind}`}>
              <span className="iso-glyph" aria-hidden="true">
                {provider.isolationKind === "kernel"
                  ? "[#]"
                  : provider.isolationKind === "none"
                    ? "[!]"
                    : "[?]"}
              </span>
              <span className="iso-word">{provider.isolation}</span>
            </dd>
          </div>
        </dl>
      </div>

      <div
        className="core-controls"
        role="group"
        aria-label="Choose a computer provider"
      >
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="btn btn-secondary"
            aria-pressed={p.id === provider.id}
            onClick={() => choose(p.id)}
          >
            {p.id}
          </button>
        ))}
      </div>

      <p className="core-hint">
        {provider.mechanism}.{" "}
        <span id="iso-keys">
          {mode === "gl"
            ? "Drag it or use the arrow keys to turn it."
            : "Drawn without WebGL — the shape carries the same reading."}
        </span>
      </p>
    </section>
  );
}

export default IsolationViewer;
