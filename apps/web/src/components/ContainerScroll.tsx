"use client";

/**
 * The tilt reveal on the `husk.yaml` frame.
 *
 * The file lies back like a card on a table as it comes into view and rotates
 * up to face the reader as they scroll into it. This section is the page's
 * tangible payoff — "here is the actual file you get" — and it is the one
 * place outside the hero and the narrative that gets a moment.
 *
 * It wraps its children and styles nothing about them. The code, the title
 * bar, the copy button and the syntax highlighting are exactly what they were;
 * this only sets two custom properties on a wrapper.
 *
 * Not GSAP. A single rotateX driven by one scroll position does not need a
 * timeline library — this is a passive listener, rAF-coalesced, writing two
 * numbers. GSAP is already paying for itself on the narrative's four-beat
 * pinned sequence; adding a second consumer here would buy nothing and the
 * budget is the budget.
 *
 * Under `prefers-reduced-motion` the listener is never attached and the
 * wrapper never gets the class that turns the perspective on, so the frame
 * renders flat and upright — which is where the animation ends anyway. An
 * entrance is removed, not collapsed.
 */

import { useEffect, useRef } from "react";

/** Degrees of lie-back at the start of the reveal. */
const MAX_TILT = 22;
/** How far under 1 the card starts, so it also grows into place. */
const MIN_SCALE = 0.94;

export function ContainerScroll({ children }: { children: React.ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let attached = false;

    const apply = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      /**
       * 0 when the top of the frame is at the bottom of the viewport, 1 by the
       * time it has travelled a third of the viewport past that. Measured from
       * the live rect on every frame rather than cached at mount, so a resize,
       * a font swap or the section above it changing height cannot leave the
       * card stuck at an angle.
       */
      const start = window.innerHeight;
      const end = window.innerHeight * 0.55;
      const p = Math.min(1, Math.max(0, (start - r.top) / Math.max(1, start - end)));
      const eased = 1 - Math.pow(1 - p, 3);
      el.style.setProperty("--tilt", `${(MAX_TILT * (1 - eased)).toFixed(2)}deg`);
      el.style.setProperty("--lift", (MIN_SCALE + (1 - MIN_SCALE) * eased).toFixed(4));
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(apply);
    };

    /* Only listen while the frame is near the viewport. On a page this long
       that is most of the reader's scrolling spent doing nothing. */
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !attached) {
          attached = true;
          el.dataset.tilt = "on";
          window.addEventListener("scroll", onScroll, { passive: true });
          window.addEventListener("resize", onScroll, { passive: true });
          apply();
        } else if (!entry.isIntersecting && attached) {
          attached = false;
          window.removeEventListener("scroll", onScroll);
          window.removeEventListener("resize", onScroll);
        }
      },
      { rootMargin: "120px 0px" },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={wrap} className="tilt-wrap">
      <div className="tilt-card">{children}</div>
    </div>
  );
}

export default ContainerScroll;
