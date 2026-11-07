import { allDocs, docBySlug } from '@/lib/content';
import { ogCard } from '@/lib/og-card';

/**
 * A share card per documentation page.
 *
 * A route handler rather than the `opengraph-image` file convention, because
 * Next will not allow that convention inside a catch-all segment — "Catch-all
 * must be the last part of the URL in route /[...slug]/opengraph-image". Here
 * the catch-all is last, which is the same thing the convention would have
 * produced.
 *
 * It is still one pipeline: the card comes out of `lib/og-card.tsx`, the same
 * renderer the landing page's `opengraph-image` uses, and the copy is the
 * frontmatter the page already carries. The title and description here are the
 * same two strings the page renders as its h1 and its lead, and the same two
 * its canonical metadata declares — so the social unfurl, the hover preview
 * and the page itself cannot disagree.
 *
 * Prerendered alongside the pages rather than rendered per request, and the
 * last segment carries `.png`. The static export writes each card as a file,
 * and `/preview/computers` cannot be a file while `/preview/computers/providers`
 * needs it to be a folder; the extension is also how the host knows to serve
 * an image.
 */
export const dynamic = 'force-static';

export function generateStaticParams() {
  return allDocs().map((doc) => ({
    slug: [...doc.slug.slice(0, -1), `${doc.slug.at(-1)}.png`],
  }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  const doc = docBySlug(slug.join('/').replace(/\.png$/, '').split('/'));
  return ogCard({
    eyebrow: doc?.sectionTitle,
    title: doc?.frontmatter.title ?? 'Husk documentation',
    lead: doc?.frontmatter.description,
  });
}
