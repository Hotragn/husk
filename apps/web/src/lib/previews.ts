/**
 * What the hover previews show.
 *
 * One entry per destination, so the three call sites cannot end up describing
 * the same page two different ways. Titles and summaries are quoted from each
 * page's own metadata; the images are the routes' own `opengraph-image`, which
 * is the same PNG the link unfurls to.
 *
 * `/preview/source` is a route handler rather than an `opengraph-image`
 * because its link goes to GitHub and there is no page for the convention to
 * attach to. Same renderer, same pipeline.
 */

export interface Preview {
  href: string;
  image: string;
  title: string;
  summary: string;
  external?: boolean;
  prefetch?: boolean;
}

export const PREVIEWS = {
  pricing: {
    href: "/pricing",
    image: "/pricing/opengraph-image",
    title: "Pricing",
    summary:
      "Husk is free and open source, with no paid plan and no trial.",
  },
  manifesto: {
    href: "/manifesto",
    image: "/manifesto/opengraph-image",
    title: "Why agents need honest sandboxes",
    summary:
      "Guardrails stop accidents. Only isolation stops a prompt-injected model.",
    /**
     * Newsreader is 113K across its two faces and /manifesto is the only route
     * that sets it. Next's default prefetch pulled both onto the homepage as
     * soon as the footer scrolled into view -- confirmed in the network panel,
     * and Chrome warned about it: "preloaded using link preload but not used".
     * The preview card is what the reader gets instead, which is the better
     * trade for a page most of them will not open.
     */
    prefetch: false,
  },
  source: {
    href: "https://github.com/Hotragn/husk",
    image: "/preview/source",
    title: "Hotragn/husk",
    summary: "Apache-2.0. Every claim on this site is checkable against it.",
    external: true,
  },
} satisfies Record<string, Preview>;
