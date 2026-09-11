import { allDocs, toc } from '@/lib/content';

/**
 * The static search index.
 *
 * Generated at build time and written out as a file, so search costs the
 * reader one request the first time they press Ctrl-K and nothing after that.
 * No Algolia, no query going to anybody else's server -- the same reason the
 * fonts are self-hosted.
 */
export const dynamic = 'force-static';

/** Strip MDX down to the prose a reader would search for. */
function plain(body: string): string {
  return body
    // Fenced code: keep it. A reader searching for `--no-model` is searching
    // for something that only ever appears inside a code fence.
    .replace(/^```[^\n]*$/gm, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`|>]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function GET() {
  const index = allDocs().map((doc) => ({
    href: doc.href,
    title: doc.frontmatter.title,
    section: doc.sectionTitle,
    description: doc.frontmatter.description,
    headings: toc(doc.body).map((h) => h.text),
    // A cap, because the whole index ships to the browser in one response and
    // the API reference alone is long enough to double it.
    text: plain(doc.body).slice(0, 12_000),
  }));

  return Response.json(index);
}
