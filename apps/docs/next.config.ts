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
};

export default nextConfig;
