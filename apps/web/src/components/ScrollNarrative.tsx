"use client";

/**
 * The chat that gets a computer, as a docked widget you scroll inside.
 *
 * It sits bottom-right behind a launcher, the way a support chat does. Open it
 * and scroll *within the panel*: the install command types into the composer,
 * it sends, the tools attach, real output lands, and the launcher's core
 * lights. Scroll back up and all of it un-happens.
 *
 * Why the panel's own scroll and not the page's
 * ---------------------------------------------
 * Two earlier arrangements drove this from the page. The first pinned a
 * full-viewport stage between the hero and "Husk does two things", which put a
 * set-piece in the middle of the page that the reader had to scroll through
 * rather than read past. The second docked the panel but still scrubbed it
 * from the window's scroll position, which is worse in a quieter way: the
 * reader is reading prose, and a widget in the corner is silently reacting to
 * it. Neither the prose nor the widget is in charge.
 *
 * Containing the scrub inside the panel makes the ownership obvious. The page
 * scroll belongs to the page again; the widget moves when the reader moves it,
 * and only while it is open. It also deletes the whole class of bug where a
 * trigger's range and a timeline's duration disagree — the panel's scroll
 * range *is* the timeline.
 *
 * How it works
 * ------------
 * Inside the panel is a track holding two children: a `position: sticky`
 * stage, and an empty spacer that supplies the scroll length. Scrolling the
 * panel moves the spacer past while the stage stays pinned, and the scroll
 * fraction is handed straight to `timeline.progress()`. That is the
 * pinned-scrub pattern in a 22rem box with no scroll library at all: GSAP is
 * here for the timeline's staggers, and ScrollTrigger is now not here.
 *
 * Two things that have to hold, and both broke on the way here. The panel must
 * be at least as tall as the stage, or sticky does not pin — it is sized from
 * the stage's measured height below. And the scroll length must be a sibling
 * element rather than padding on the track, because a sticky child is
 * constrained to its parent's content box and padding is not content.
 *
 * Nothing in it is invented. The command is `MCP_COMMAND`, the same string the
 * hero's install block sets. The transcript is the `uname -sr` / note.txt
 * exchange out of `TRANSCRIPT`, which ran on a real machine. The four tool
 * names come from `MCP_TOOLS` and are captioned "the conversation now has",
 * not "these fired" — the exchange below them is three shell calls, and four
 * names over it would imply four tools ran.
 *
 * Why scroll and not time
 * -----------------------
 * A headline that types itself is lying about latency. A transcript being
 * dragged by a scrollbar is a diagram: the reader sets the clock, it runs
 * backwards as readily as forwards, and it claims nothing about how long the
 * real thing takes. See `brand/UI-PRINCIPLES.md` §3, "Scroll as a clock".
 *
 * SEO, no-JS, and the hiding problem
 * ----------------------------------
 * There is one copy of this content and it ships in the document, visible, in
 * the page flow. `[data-anim="on"]` — set by script after mount — is what
 * lifts that same element out of the flow, into the fixed dock, and gives the
 * track its scroll length. A crawler, a reader with JS off, a failed hydration
 * and anyone who asked for less motion all get a plain readable transcript in
 * the body of the page instead of a floating widget they cannot open.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { HuskMark } from "@/components/Logo";
import { MCP_COMMAND, MCP_TOOLS, TRANSCRIPT } from "@/lib/content";

const USED_TOOLS = ["shell", "read_file", "write_file", "expose_port"] as const;
const toolWhat = (name: string) => MCP_TOOLS.find((t) => t.name === name)?.what ?? "";

/* Lifted from TRANSCRIPT by matching its text rather than by index — an index
   would silently animate the wrong three lines the first time anyone adds a
   command to that array. */
const EXCHANGE = (() => {
  const i = TRANSCRIPT.findIndex((l) => l.text.includes("uname -sr"));
  return i === -1 ? [] : TRANSCRIPT.slice(i, i + 3);
})();

export function ScrollNarrative() {
  const section = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  /* Whether the panel has been scrolled at all. Drives the hint, which has
     done its job the moment it is obeyed. */
  const [moved, setMoved] = useState(false);

  /* Opening starts the story at the top. Done in the handler rather than an
     effect watching `open`: this is the event that caused it, the panel is
     already in the DOM (collapsed, not unmounted), and mirroring the state
     into an effect to do the same work is a cascading render for no gain. */
  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      if (!wasOpen) {
        const panel = section.current?.querySelector<HTMLElement>(".nr-panel");
        if (panel) panel.scrollTop = 0;
        setMoved(false);
      }
      return !wasOpen;
    });
  }, []);

  useEffect(() => {
    const root = section.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    /* Near-viewport before the library is fetched. A reader who never scrolls
       this far never downloads GSAP. */
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        void start();
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(root);

    async function start() {
      const { gsap } = await import("gsap");
      if (cancelled || !root) return;

      root.dataset.anim = "on";

      const q = gsap.utils.selector(root);
      const typed = q(".nr-typed")[0] as HTMLElement | undefined;
      const panel = q(".nr-panel")[0] as HTMLElement | undefined;
      const full = MCP_COMMAND;
      /* Ships with the command in it, for the no-JS reader. The timeline owns
         it from here. */
      if (typed) typed.textContent = "";

      let tl: gsap.core.Timeline | undefined;

      const ctx = gsap.context(() => {
        /* Paused, and never played. Its progress is set from the panel's
           scroll, so the timeline is a lookup table rather than a clock. */
        tl = gsap.timeline({ paused: true });

        tl.to(
          { i: 0 },
          {
            i: full.length,
            ease: "none",
            duration: 1.1,
            onUpdate() {
              if (!typed) return;
              const n = Math.round(this.targets()[0].i as number);
              typed.textContent = full.slice(0, n);
            },
          },
          0.2,
        );

        tl.to(q(".nr-composer"), { opacity: 0.3, duration: 0.2 }, 1.35);
        tl.fromTo(q(".nr-sent"), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.3 }, 1.35);
        tl.fromTo(q(".nr-gained"), { opacity: 0 }, { opacity: 1, duration: 0.25 }, 1.6);
        tl.fromTo(
          q(".nr-tool"),
          { opacity: 0, x: -8 },
          { opacity: 1, x: 0, duration: 0.26, stagger: 0.13 },
          1.7,
        );
        tl.fromTo(
          q(".nr-line"),
          { opacity: 0, x: -8 },
          { opacity: 1, x: 0, duration: 0.24, stagger: 0.12 },
          2.35,
        );
        // The machine is attached, and the launcher's core lights to say so.
        tl.fromTo(q(".nr-attached"), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.35 }, 3.0);
        tl.to(root, { "--nr-lit": 1, duration: 0.4 }, 3.0);
        /* Trailing slack, so the last line is not arriving on the final pixel
           of the scroll. */
        tl.to({}, { duration: 0.6 }, 3.4);
      }, root);

      /**
       * The panel is sized to its own content.
       *
       * `.nr-stage` is `position: sticky`, and a sticky element taller than
       * its scrollport does not pin — it scrolls until its bottom edge, which
       * is exactly what happened at the first attempt: the stage was 546px in
       * a 479px panel, so scrubbing scrolled the transcript out of the box
       * instead of holding it still. Sticky only works here if the panel is at
       * least as tall as the stage, and the stage's height depends on the
       * content and the font, so it is measured rather than guessed.
       *
       * The clamp is the room the launcher and the gutters need. If a viewport
       * is too short even for that, the stage stops pinning and scrolls — a
       * worse experience than the scrub, but a readable one, and only on
       * windows under about 700px tall.
       */
      const stage = q(".nr-stage")[0] as HTMLElement | undefined;
      const fitPanel = () => {
        if (!panel || !stage) return;
        const room = window.innerHeight - 9 * 16;
        /* The rect, not scrollHeight: scrollHeight is an integer and the real
           height is fractional, so rounding down left the panel one pixel
           short of the stage and sticky refused to pin. Ceil, plus a pixel. */
        const needed = Math.ceil(stage.getBoundingClientRect().height) + 1;
        panel.style.height = `${Math.min(needed, room)}px`;
      };
      fitPanel();
      window.addEventListener("resize", fitPanel, { passive: true });

      /* rAF-coalesced: a scroll event can fire several times a frame, and
         `progress()` writes to the DOM. */
      let frame = 0;
      const read = () => {
        frame = 0;
        if (!panel || !tl) return;
        const range = panel.scrollHeight - panel.clientHeight;
        const p = range > 0 ? Math.min(Math.max(panel.scrollTop / range, 0), 1) : 0;
        tl.progress(p);
      };
      const onScroll = () => {
        setMoved(true);
        if (frame) return;
        frame = window.requestAnimationFrame(read);
      };

      panel?.addEventListener("scroll", onScroll, { passive: true });
      read();

      cleanup = () => {
        panel?.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", fitPanel);
        if (panel) panel.style.height = "";
        if (frame) window.cancelAnimationFrame(frame);
        ctx.revert();
        delete root.dataset.anim;
        if (typed) typed.textContent = full;
      };
    }

    return () => {
      cancelled = true;
      io.disconnect();
      cleanup?.();
    };
  }, []);

  return (
    <section
      ref={section}
      className="narrative"
      aria-label="What one line of install does to a chat"
    >
      <div
        className="nr-dock"
        data-open={open ? "true" : "false"}
        data-moved={moved ? "true" : "false"}
      >
        <button
          type="button"
          className="nr-launcher"
          aria-expanded={open}
          aria-controls="nr-panel"
          onClick={toggle}
        >
          <HuskMark size={24} />
          <span className="nr-launcher-label">
            {open ? "Hide the transcript" : "What one line does"}
          </span>
        </button>

        {/* Focusable, because its content is scrollable and a keyboard has to
            be able to reach that scroll. */}
        <div className="nr-panel" id="nr-panel" tabIndex={0}>
          <div className="nr-track">
            <div className="nr-stage">
              <div className="nr-head">
                <span className="nr-title">before and after one line</span>
                <span className="nr-hint" aria-hidden="true">
                  scroll
                </span>
                <button
                  type="button"
                  className="nr-close"
                  onClick={toggle}
                  aria-label="Hide the transcript"
                >
                  <svg
                    viewBox="0 0 12 12"
                    width="12"
                    height="12"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d="M2 2 L10 10 M10 2 L2 10"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                </button>
              </div>

              <div className="nr-body">
                <p className="nr-sent">
                  <span className="nr-who">you</span>
                  <code className="nr-cmd">{MCP_COMMAND}</code>
                </p>

                <p className="nr-gained">the conversation now has</p>
                <ul className="nr-tools">
                  {USED_TOOLS.map((name) => (
                    <li className="nr-tool" key={name}>
                      <span className="nr-tool-name">{name}</span>
                      <span className="nr-tool-what">{toolWhat(name)}</span>
                    </li>
                  ))}
                </ul>

                <pre className="nr-out">
                  {EXCHANGE.map((line) => (
                    <span className={`nr-line nr-line-${line.kind}`} key={line.text}>
                      {line.text}
                    </span>
                  ))}
                </pre>

                <p className="nr-attached">
                  <span className="nr-attached-dot" aria-hidden="true" />a computer, for
                  the rest of the conversation
                </p>
              </div>

              <div className="nr-composer">
                <span className="nr-typed">{MCP_COMMAND}</span>
                <span className="nr-caret" aria-hidden="true" />
              </div>
            </div>

            {/* The scrub length, as a real element rather than padding on the
                track. A sticky child is constrained to its parent's *content*
                box, so padding-bottom gave the stage nowhere to stick through
                and it scrolled away like any other block. An empty sibling is
                content, and the stage pins across all of it. */}
            <div className="nr-spacer" aria-hidden="true" />
          </div>
        </div>
      </div>
    </section>
  );
}

export default ScrollNarrative;
