import type { NextConfig } from 'next';

/**
 * The docs site is a static content pipeline: MDX on disk, compiled at build
 * time, served as HTML. There is no database, no CMS, and no request-time
 * rendering, so it ships as a static export (below).
 *
 * The workspace root is left to Next's own detection: this app is an npm workspace and
 * both `next` and the lockfile live at the monorepo root, so pinning the root here
 * would put the Next package outside it.
 */
const nextConfig: NextConfig = {
  // MDX is compiled through next-mdx-remote/rsc rather than the @next/mdx
  // loader, so pages can live outside app/ and the sidebar can be generated
  // from their frontmatter.
  pageExtensions: ['ts', 'tsx'],

  /**
   * A static export: `next build` writes every page, Open Graph card,
   * robots.txt and sitemap.xml to `out/`, and Cloudflare serves that directory
   * (`wrangler.jsonc`). Nothing runs per request, which is why every metadata
   * route declares `dynamic = 'force-static'` -- an export refuses to build one
   * that does not -- and why next/image's optimizer, a server, is off.
   *
   * Security headers are in `public/_headers`, because an export ignores a
   * `headers()` function here and Cloudflare reads `_headers` from the output.
   * HSTS there is belt and braces: `.dev` is on the browser preload list at the
   * TLD. The CSP is deliberately partial. `frame-ancestors`, `base-uri`,
   * `object-src` and `form-action` close clickjacking, base-tag injection and
   * plugin embeds without touching how the page loads; nothing on this site
   * frames another page, is framed, or posts a form.
   *
   * ponytail: no script-src/style-src. Next inlines its bootstrap scripts and
   * styles, and a static file has no per-request nonce to give them. Hash the
   * inline scripts at build time if the site ever renders user-supplied content.
   */
  output: 'export',
  images: { unoptimized: true },
  // Next's default, written down: `sitemap.ts` emits the no-slash form for all
  // thirty-eight pages, and `/start/quickstart/` 308s to `/start/quickstart`.
  // A default that moves across a major version would move every canonical URL
  // on the site with it.
  trailingSlash: false,
};

export default nextConfig;
