import type { NextConfig } from "next";

/**
 * `trailingSlash: false` is Next's default and is written down anyway, because
 * it is the canonical-URL contract the rest of the site is built on: every
 * `sitemap.ts` entry, every `alternates.canonical`, and the redirect a reader
 * gets for `/manifesto/` all assume the no-slash form. A default that changes
 * across a major version would move all of them at once, silently.
 */
const nextConfig: NextConfig = {
  trailingSlash: false,

  /**
   * A static export: `next build` writes every page, Open Graph card,
   * robots.txt and sitemap.xml to `out/`, and Cloudflare serves that directory
   * (`wrangler.jsonc`). Nothing runs per request, which is why every metadata
   * route declares `dynamic = "force-static"` -- an export refuses to build one
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
  output: "export",
  images: { unoptimized: true },

  /**
   * Lighthouse flagged "missing source maps for large first-party JavaScript".
   * The bundle is first-party and Apache-2.0 -- the source is already public,
   * so there is nothing here a map could leak, and without one a production
   * stack trace names a minified symbol.
   *
   * The maps are emitted as separate `.map` files and only fetched when a
   * reader opens devtools, so this costs deployment size and nothing on the
   * critical path.
   */
  productionBrowserSourceMaps: true,

  experimental: {
    /**
     * Against the ~146 KiB of unused JavaScript in the same report. These are
     * barrel packages: `import { Canvas } from "@react-three/fiber"` pulls the
     * whole index through the bundler's side-effect analysis. Rewriting each
     * named import to its own module lets tree-shaking see what is actually
     * reachable. `three` is the one that matters -- it is the largest
     * dependency on the site by an order of magnitude.
     */
    optimizePackageImports: ["three", "@react-three/fiber"],
  },
};

export default nextConfig;
