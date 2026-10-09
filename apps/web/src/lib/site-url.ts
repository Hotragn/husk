/**
 * Where this site lives, resolved once.
 *
 * Feeds `metadataBase`, every canonical tag, every Open Graph URL, robots.txt
 * and sitemap.xml. A wrong value here does not fail a build -- it ships a
 * production page whose canonical says `http://localhost:3000/`, which is what
 * happened, on every route, across both deployments.
 *
 * A production build -- `next build`, which is every deploy -- names the real
 * address, and only `next dev` names localhost. `NEXT_PUBLIC_SITE_URL` wins
 * over both, for a build meant to describe some other host; it is typed by
 * hand, so its trailing slash is stripped before it doubles in every sitemap
 * entry.
 *
 * www is the address. huskai.dev redirects to it at Cloudflare, so a canonical
 * naming the apex would point every crawler at a redirect.
 */

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

export const SITE_URL = stripTrailingSlash(
  process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.NODE_ENV === "production"
      ? "https://www.huskai.dev"
      : "http://localhost:3000"),
);
