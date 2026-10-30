/**
 * Where this site lives, resolved once.
 *
 * Same resolution as `apps/web/src/lib/site-url.ts`, and deliberately a second
 * copy rather than a shared package: these are two Vercel projects with two
 * different `NEXT_PUBLIC_SITE_URL` values, and neither app depends on the
 * other at build time.
 *
 * Three sources, in order:
 *
 *   1. `NEXT_PUBLIC_SITE_URL`          -- set it in the Vercel project. Always
 *                                         wins: Vercel's own variables keep
 *                                         naming the `.vercel.app` host even
 *                                         after a custom domain is attached.
 *   2. `VERCEL_PROJECT_PRODUCTION_URL` -- the project's production hostname,
 *                                         identical on every deployment, so a
 *                                         preview build emits production
 *                                         canonicals rather than pointing a
 *                                         crawler at a throwaway host.
 *   3. `VERCEL_URL`                    -- this deployment. A real host at least.
 *
 * Neither Vercel variable is `NEXT_PUBLIC_`, so both read `undefined` in a
 * client bundle. Import this from server code only -- metadata, robots and
 * sitemap. `site.ts` holds the constants that client components may read.
 *
 * The local fallback is port 3001, not 3000: `apps/web` owns 3000, and running
 * both at once is the normal case when a link crosses between them.
 */

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

const withScheme = (host: string) =>
  /^https?:\/\//i.test(host) ? host : `https://${host}`;

function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return stripTrailingSlash(withScheme(explicit));

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (production) return stripTrailingSlash(withScheme(production));

  const deployment = process.env.VERCEL_URL;
  if (deployment) return stripTrailingSlash(withScheme(deployment));

  return 'http://localhost:3001';
}

export const SITE_URL = resolveSiteUrl();
