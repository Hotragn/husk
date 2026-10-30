"use client";

/**
 * A link that shows you where it goes before you commit to it.
 *
 * Hovering or focusing shows a small floating card: the page's own share
 * image, its title, and one line. The image is the route's `opengraph-image`,
 * so what a reader sees on hover is the same PNG the link unfurls to in a chat
 * window — one image doing two jobs, and no second pipeline to keep in step.
 *
 * Why the card is `position: fixed`
 * ---------------------------------
 * An absolutely-positioned card is clipped by any ancestor with `overflow:
 * hidden`, and one of the places this is used — the docs section grid — is
 * exactly that: `overflow: hidden` is what gives that grid its hairline
 * dividers. A card anchored to the viewport escapes the clip, and it also
 * makes edge handling possible: the open handler measures the trigger, clamps
 * the card inside the gutters, and flips it below the link when there is not
 * room above. An absolute card can do none of that without a second layout
 * pass.
 *
 * What makes this safe rather than decorative
 * -------------------------------------------
 * The anchor is a plain anchor and keeps its own classes, so a card or a
 * button that gets a preview looks and behaves exactly as it did. The floating
 * card is `aria-hidden` and adds nothing to the accessibility tree: a screen
 * reader gets the link text, which already says where it goes, rather than a
 * duplicate of the destination's title on every focus. The card never affects
 * layout, so it cannot reflow the sentence it sits in.
 *
 * The image is requested on the first hover and never on a touch device, where
 * there is no hover to preview with. Not rendering the `img` until intent is
 * shown is what keeps these off the critical path.
 *
 * A 90ms open delay, so running the pointer across a paragraph of links does
 * not strobe. Close is immediate: a card lingering over the text you are
 * trying to read is worse than one that never appeared.
 */

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

export interface LinkPreviewProps {
  href: string;
  /** The share image for the destination. */
  image: string;
  /** The destination's own title. */
  title: string;
  /** One line, in the destination's own words. */
  summary: string;
  /** An external destination gets an anchor rather than a next/link. */
  external?: boolean;
  /**
   * Passed to next/link. Worth turning off for a route whose assets are
   * heavier than the navigation is likely: prefetching pulls the destination's
   * fonts and CSS on a page that may never go there. The preview card already
   * shows the reader what is on the other side, which is most of what the
   * prefetch was buying.
   */
  prefetch?: boolean;
  children: React.ReactNode;
  className?: string;
}

const OPEN_DELAY = 90;
const CARD_W = 320;
const CARD_H = 250;
const GAP = 10;
const EDGE = 12;

export function LinkPreview({
  href,
  image,
  title,
  summary,
  external,
  prefetch,
  children,
  className,
}: LinkPreviewProps) {
  const [open, setOpen] = useState(false);
  /* Once true it stays true: the browser has the image, and unmounting would
     make the next hover fetch it again. */
  const [everOpened, setEverOpened] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const place = useCallback(() => {
    const anchor = wrap.current;
    const el = card.current;
    if (!anchor || !el) return;
    const r = anchor.getBoundingClientRect();

    const half = CARD_W / 2;
    const min = EDGE + half;
    const max = window.innerWidth - EDGE - half;
    const x = Math.min(Math.max(r.left + r.width / 2, min), Math.max(min, max));

    /* Above by default; below when the trigger is too near the top for the
       card to fit, which is the common case for a link in a page heading. */
    const fitsAbove = r.top >= CARD_H + GAP;
    const y = fitsAbove ? r.top - GAP : r.bottom + GAP;

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.dataset.side = fitsAbove ? "above" : "below";
  }, []);

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setEverOpened(true);
      setOpen(true);
      /* After the card exists, so there is something to measure. */
      requestAnimationFrame(place);
    }, OPEN_DELAY);
  }, [place]);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }, []);

  /* A fixed card does not travel with the page, so it is dismissed on scroll
     rather than left floating over unrelated content. */
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("resize", hide, { passive: true });
    return () => {
      window.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  /* Pointer type, not a media query: a hybrid laptop has both, and the useful
     question is what the reader just used. */
  const onPointerEnter = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      show();
    },
    [show],
  );

  const handlers = {
    onPointerEnter,
    onPointerLeave: hide,
    onFocus: show,
    onBlur: hide,
  };

  return (
    <span ref={wrap} className="lp" data-open={open ? "true" : "false"}>
      {external ? (
        <a className={className} href={href} rel="noreferrer noopener" {...handlers}>
          {children}
        </a>
      ) : (
        <Link className={className} href={href} prefetch={prefetch} {...handlers}>
          {children}
        </Link>
      )}

      {everOpened ? (
        <span ref={card} className="lp-card" aria-hidden="true">
          <Image
            className="lp-img"
            src={image}
            alt=""
            width={CARD_W}
            height={168}
            unoptimized
          />
          <span className="lp-text">
            <span className="lp-title">{title}</span>
            <span className="lp-summary">{summary}</span>
          </span>
        </span>
      ) : null}
    </span>
  );
}

export default LinkPreview;
