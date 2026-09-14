"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CopyButton } from "@/components/CopyButton";
import { TRANSCRIPT, TRANSCRIPT_TEXT, type LineKind } from "@/lib/content";

/**
 * A replay of a session that actually ran.
 *
 * UI-PRINCIPLES.md §3 bans typewriter effects on marketing copy and permits
 * animating streamed output, "because it is genuinely arriving over time".
 * This is the second case: the timings below are per-line character rates for
 * a real terminal — a typed command is slow, its output is not — and nothing
 * here pretends to be thinking.
 *
 * The full transcript is in the DOM at first paint and the reveal is opacity
 * only. So: no layout shift, no reflow at any point in the replay, the text is
 * selectable and copyable before it has "arrived", and a screen reader gets
 * the whole thing immediately rather than one character at a time.
 *
 * Under prefers-reduced-motion nothing plays, the transcript is simply there,
 * and the replay control is not offered.
 */

const GAP_AFTER_PROMPT = 0.3;
const GAP_AFTER_BLANK = 0.12;
const GAP_DEFAULT = 0.045;

interface Timed {
  kind: LineKind;
  text: string;
  rate: number;
  start: number;
}

const TIMELINE: Timed[] = (() => {
  let t = 0;
  return TRANSCRIPT.map((line) => {
    const rate = line.rate ?? 400;
    const entry: Timed = { kind: line.kind, text: line.text, rate, start: t };
    t +=
      line.text.length / rate +
      (line.kind === "prompt"
        ? GAP_AFTER_PROMPT
        : line.kind === "blank"
          ? GAP_AFTER_BLANK
          : GAP_DEFAULT);
    return entry;
  });
})();

const TOTAL = TIMELINE.reduce(
  (max, l) => Math.max(max, l.start + l.text.length / l.rate),
  0,
);

const CLASS_FOR: Record<LineKind, string> = {
  prompt: "term-prompt",
  out: "term-out",
  dim: "term-dim",
  ok: "term-ok",
  err: "term-err",
  key: "term-key",
  blank: "term-out",
};

function Line({ line, elapsed }: { line: Timed; elapsed: number }) {
  const shown =
    elapsed >= TOTAL
      ? line.text.length
      : Math.max(0, Math.min(line.text.length, Math.floor((elapsed - line.start) * line.rate)));

  const head = line.text.slice(0, shown);
  const tail = line.text.slice(shown);

  return (
    <span className={`term-line ${CLASS_FOR[line.kind]}`}>
      {head}
      {tail ? <span className="term-veil">{tail}</span> : null}
      {"\n"}
    </span>
  );
}

export function TerminalReplay() {
  const [elapsed, setElapsed] = useState(TOTAL);
  const [reduced, setReduced] = useState(true);
  const [playing, setPlaying] = useState(false);
  const hasPlayed = useRef(false);
  const raf = useRef<number | null>(null);
  const started = useRef(0);
  const region = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const stop = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setPlaying(false);
  }, []);

  const play = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    started.current = performance.now();
    setElapsed(0);
    setPlaying(true);
    const tick = (now: number) => {
      const t = (now - started.current) / 1000;
      if (t >= TOTAL) {
        setElapsed(TOTAL);
        raf.current = null;
        setPlaying(false);
        return;
      }
      setElapsed(t);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  const skip = useCallback(() => {
    stop();
    setElapsed(TOTAL);
  }, [stop]);

  // Play once, when the reader has actually scrolled it into view. Never
  // again on its own: a block that re-runs every time it crosses the fold is
  // motion the reader did not ask for.
  useEffect(() => {
    if (reduced) return;
    const el = region.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasPlayed.current) {
          hasPlayed.current = true;
          play();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced, play]);

  // Never keep a loop alive in a hidden tab.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && raf.current !== null) skip();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [skip]);

  useEffect(() => stop, [stop]);

  const lines = useMemo(
    () =>
      TIMELINE.map((line, i) => (
        <Line key={i} line={line} elapsed={reduced ? TOTAL : elapsed} />
      )),
    [elapsed, reduced],
  );

  return (
    <div className="frame" ref={region}>
      <div className="frame-bar">
        <span className="frame-title">
          windows laptop · no docker daemon · no api key
        </span>
        <span className="frame-actions">
          {!reduced && (
            <button
              type="button"
              className="btn btn-ghost copy-btn"
              onClick={playing ? skip : play}
            >
              {playing ? "Skip" : "Replay"}
            </button>
          )}
          <CopyButton value={TRANSCRIPT_TEXT} what="transcript" />
        </span>
      </div>
      <pre
        className="term term-wide"
        tabIndex={0}
        role="group"
        aria-label="Recorded husk session"
      >
        {lines}
      </pre>
    </div>
  );
}

export default TerminalReplay;
