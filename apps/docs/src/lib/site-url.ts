/**
 * Where this site lives, resolved once.
 *
 * Feeds `metadataBase`, every canonical tag, every Open Graph URL, robots.txt
 * and sitemap.xml. A wrong value here does not fail a build -- it ships a
 * production page whose canonical says `http://localhost:3001/`, which is what
 * happened, on every route, across both deployments.
 *
 * A production build -- `next build`, which is every deploy -- names the real
 * address, and only `next dev` names localhost. `NEXT_PUBLIC_SITE_URL` wins
 * over both, for a build meant to describe some other host; it is typed by
 * hand, so its trailing slash is stripped before it doubles in every sitemap
 * entry.
 *
 * The local fallback is port 3001, not 3000: `apps/web` owns 3000, and running
 * both at once is the normal case when a link crosses between them.
 */

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

export const SITE_URL = stripTrailingSlash(
  process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.NODE_ENV === 'production'
      ? 'https://docs.huskai.dev'
      : 'http://localhost:3001'),
);
