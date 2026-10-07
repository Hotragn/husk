/**
 * Where this site lives, resolved once.
 *
 * Feeds `metadataBase`, every canonical tag, every Open Graph URL, robots.txt
 * and sitemap.xml. A wrong value here does not fail a build -- it ships a
 * production page whose canonical says `http://localhost:3000/`, which is what
 * happened, on every route, across both deployments.
 *
 * Three sources, in order:
 *
 *   1. `NEXT_PUBLIC_SITE_URL`     -- set it in the Vercel project. Always wins,
 *                                    because it is the only one that survives a
 *                                    custom domain: Vercel's own variables keep
 *                                    naming the `.vercel.app` host even after
 *                                    `huskai.dev` is pointed at the project.
 *   2. `VERCEL_PROJECT_PRODUCTION_URL` -- the project's production hostname,
 *                                    the same value on every deployment, so a
 *                                    preview build still emits production
 *                                    canonicals rather than pointing search
 *                                    engines at a throwaway host.
 *   3. `VERCEL_URL`               -- this specific deployment. Last resort; it
 *                                    is at least a real host that answers.
 *
 * Neither Vercel variable is `NEXT_PUBLIC_`, so in a client bundle both are
 * replaced with `undefined` and this falls back to localhost. That is why this
 * module is separate from `content.ts`: `content.ts` is imported by client
 * components, and this must only ever be imported by server code -- metadata,
 * robots, sitemap, and the OG image routes. See the note in `content.ts`.
 *
 * Vercel supplies the two hostnames bare, with no scheme (`husk.vercel.app`),
 * so the scheme is added here. `new URL()` in `metadataBase` throws on a bare
 * hostname, which would turn a missing scheme into a build failure rather than
 * a silent wrong tag -- but only for the variable that happens to be set.
 */

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

const withScheme = (host: string) =>
  /^https?:\/\//i.test(host) ? host : `https://${host}`;

function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return stripTrailingSlash(withScheme(explicit));

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (production) return stripTrailingSlash(withScheme(production));

  const deployment = process.env.VERCEL_URL;
  if (deployment) return stripTrailingSlash(withScheme(deployment));

  return "http://localhost:3000";
}

export const SITE_URL = resolveSiteUrl();
