import type { NextConfig } from 'next';

/**
 * The docs site is a static content pipeline: MDX on disk, compiled at build
 * time, served as HTML. There is no database, no CMS, and no request-time
 * rendering, so `output: 'export'` stays a one-line change if a plain file host
 * is ever wanted.
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
  poweredByHeader: false,

  /**
   * Security headers, on every response.
   *
   * HSTS is belt and braces: `.dev` is on the browser preload list at the TLD,
   * so browsers refuse plain HTTP here regardless. The CSP is deliberately
   * partial. `frame-ancestors`, `base-uri`, `object-src` and `form-action`
   * close clickjacking, base-tag injection and plugin embeds without touching
   * how the page loads; nothing on this site frames another page, is framed,
   * or posts a form.
   *
   * ponytail: no script-src/style-src. Next inlines its bootstrap scripts and
   * styles, so a real script policy needs per-request nonces from middleware.
   * Add that if the site ever renders user-supplied content.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
          },
        ],
      },
    ];
  },
  // Next's default, written down: `sitemap.ts` emits the no-slash form for all
  // thirty-eight pages, and `/start/quickstart/` 308s to `/start/quickstart`.
  // A default that moves across a major version would move every canonical URL
  // on the site with it.
  trailingSlash: false,
};

export default nextConfig;
