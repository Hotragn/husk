import { LICENCE, REPO_URL } from "@/lib/content";
import { ogCard } from "@/lib/og-card";

/**
 * The card behind the "Read the source" hover preview.
 *
 * A route handler rather than an `opengraph-image`, because there is no
 * `/source` page for that convention to attach to — the link goes to GitHub.
 * It still comes out of `lib/og-card.tsx`, so this is the same pipeline and
 * not a second one.
 *
 * Not GitHub's own `opengraph.githubassets.com` render, which would have been
 * the lazy option: this site self-hosts its fonts so that a page view does not
 * become a request to a font CDN, and a hover preview is not the place to add
 * another third party for one PNG. The one it does have, PostHog, is disclosed.
 */
export const dynamic = "force-static";

export function GET() {
  return ogCard({
    eyebrow: "source",
    title: "Read the source.",
    lead: `Every claim on this site is checkable against the repository. ${LICENCE}.`,
    note: REPO_URL.replace("https://", ""),
  });
}
