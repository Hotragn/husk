/**
 * Site-wide constants.
 *
 * `HUSK_VERSION` is typed here, because this site is outside the npm workspace
 * and cannot import the root manifest. `npm run drift -- --sites` is what stops
 * it claiming a version the repo is not on -- and that job is advisory, so a
 * release that forgets this line goes red somewhere nobody is required to look.
 * It was left on 0.1.3 through the whole of 0.1.4 for exactly that reason.
 */
/**
 * `SITE_URL` is deliberately not here. It reads Vercel's `VERCEL_*` variables,
 * which are not `NEXT_PUBLIC_` and so resolve to `undefined` in a client
 * bundle. It lives in `lib/site-url.ts`, which only server code may import.
 *
 * The trailing slash is stripped there for the reason it was stripped here: a
 * dashboard field is a text box, and an unstripped slash reaches robots.txt and
 * all thirty-eight sitemap entries as a double slash.
 */

export const SITE_NAME = 'Husk docs';
export const SITE_DESCRIPTION =
  'Husk gives any AI agent a disposable Linux computer, and turns any chat into a bot. Runs free on your machine. No account, no telemetry.';

export const REPO_URL = 'https://github.com/Hotragn/husk';

/**
 * Where the link back to the main site goes.
 *
 * The docs had no route back to husk.dev and the main site had no route in
 * here; the nav now closes the loop in both directions. Set
 * `NEXT_PUBLIC_WEB_URL` on this Vercel project to the marketing deployment.
 *
 * The fallback is split on environment rather than being one value. In `next
 * dev` the marketing site is on port 3000 -- running both at once is the normal
 * case when a link crosses between them, and a dev link to GitHub would never
 * be exercised locally. In production an unset variable falls back to the
 * README, which is a page that answers, rather than to a localhost URL nobody
 * outside this machine can reach.
 */
const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

export const WEB_URL = stripTrailingSlash(
  process.env.NEXT_PUBLIC_WEB_URL ??
    (process.env.NODE_ENV === 'production'
      ? `${REPO_URL}#readme`
      : 'http://localhost:3000'),
);
export const REPO_EDIT_BASE = `${REPO_URL}/edit/main/apps/docs/content`;
export const LICENCE = 'Apache-2.0';

/** The version the docs describe. Matches the version field in every workspace package. */
export const HUSK_VERSION = '0.1.4';
