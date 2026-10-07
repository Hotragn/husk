/**
 * Site-wide constants.
 *
 * `HUSK_VERSION` is typed here, because this site is outside the npm workspace
 * and cannot import the root manifest. `npm run drift -- --sites` is what stops
 * it claiming a version the repo is not on -- and that job is advisory, so a
 * release that forgets this line goes red somewhere nobody is required to look.
 * It was left on 0.1.3 through the whole of 0.1.4 for exactly that reason.
 */

export const SITE_NAME = 'Husk docs';
export const SITE_DESCRIPTION =
  'Save sources and AI results in local workspaces. Start with a cited brief, then add computer tools when you need them. No Husk account required.';

export const REPO_URL = 'https://github.com/Hotragn/husk';

/**
 * Where the link back to the main site goes.
 *
 * www.huskai.dev from a production build, the marketing dev server on port
 * 3000 under `next dev` -- running both at once is the normal case when a link
 * crosses between them. `NEXT_PUBLIC_WEB_URL` overrides both.
 */
const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

export const WEB_URL = stripTrailingSlash(
  process.env.NEXT_PUBLIC_WEB_URL ??
    (process.env.NODE_ENV === 'production'
      ? 'https://www.huskai.dev'
      : 'http://localhost:3000'),
);
export const REPO_EDIT_BASE = `${REPO_URL}/edit/main/apps/docs/content`;
export const LICENCE = 'Apache-2.0';

/** The version the docs describe. Matches the version field in every workspace package. */
export const HUSK_VERSION = '0.2.0';
