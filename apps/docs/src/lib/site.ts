/**
 * Site-wide constants.
 *
 * `HUSK_VERSION` is read from the monorepo root package.json rather than typed
 * here, so the docs cannot claim a version the repo is not on.
 */
export const SITE_NAME = 'Husk docs';
export const SITE_DESCRIPTION =
  'Husk gives any AI agent a disposable Linux computer, and turns any chat into a bot. Runs free on your machine. No account, no telemetry.';

export const REPO_URL = 'https://github.com/Hotragn/husk';
export const REPO_EDIT_BASE = `${REPO_URL}/edit/main/apps/docs/content`;
export const LICENCE = 'Apache-2.0';

/** The version the docs describe. Matches the version field in every workspace package. */
export const HUSK_VERSION = '0.1.1';
