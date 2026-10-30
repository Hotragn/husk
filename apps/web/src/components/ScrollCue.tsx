"use client";

/**
 * One line and one chevron, under the hero.
 *
 * Its only job is getting the reader past the first screen. "Three things to
 * ask it first" already does the onboarding, further down, for someone who has
 * installed the thing — this is the nudge that gets them there, and nothing
 * more: no modal, no tour, no step counter.
 *
 * It is an anchor, not a decoration, so it works by being clicked as well as
 * by being read, and `scroll-padding-top` on `html` already clears the sticky
 * header for it.
 *
 * It removes itself the moment the reader does the thing it is asking for.
 * A cue that is still pointing down after you have scrolled is furniture.
 */

import { useEffect, useState } from "react";

export function ScrollCue({ href = "#jobs-title" }: { href?: string }) {
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > 120) setGone(true);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <a className="scroll-cue" href={href} data-gone={gone ? "true" : "false"}>
      <span className="scroll-cue-label">Keep scrolling</span>
      <svg
        className="scroll-cue-chevron"
        viewBox="0 0 16 10"
        width="16"
        height="10"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M1 1 L8 8 L15 1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}

export default ScrollCue;
