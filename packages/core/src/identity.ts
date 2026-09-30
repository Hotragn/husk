/**
 * Who husk says it is, on the wire.
 *
 * Two facts live here and nothing else does: the version, and the repository.
 * Everything husk sends about itself is built from them.
 *
 * ## Why they are together, and why the strings are not written out
 *
 * There used to be three User-Agent literals, each holding both facts at once:
 *
 *     'husk/0.1.4 (+https://github.com/Hotragn/husk)'
 *
 * A version bump has to edit that string. So does a change to the repository
 * URL. When both happened at once the merge had no correct side -- `--theirs`
 * takes the new version with the old URL, `--ours` takes the reverse, and a
 * conflict marker cannot tell you that one line encodes two facts. Git has a
 * representation of "line" and none of "fact".
 *
 * Interpolating removes the shared literal, so the collision has nowhere left
 * to happen. Each fact has one home, and a bump touches one of them.
 *
 * These two constants are still copies -- of the root `package.json`'s
 * `version` and `repository.url` -- because a published package cannot read
 * the workspace manifest at runtime. That copy is watched by
 * `scripts/drift-check.mjs`, which treats the root manifest as the arbiter.
 * Two watched copies are the floor here; six unwatched literals were not.
 */

/** Must equal the root manifest's `version`. Asserted by the drift check. */
export const HUSK_VERSION = '0.1.4';

/**
 * Must equal the root manifest's `repository.url`, without the `git+` prefix
 * or the `.git` suffix. Asserted by the drift check.
 */
export const HUSK_REPO = 'https://github.com/Hotragn/husk';

/** What husk sends when husk is doing the talking: the API client, the model router. */
export const HUSK_USER_AGENT = `husk/${HUSK_VERSION} (+${HUSK_REPO})`;

/**
 * What husk sends when fetching a page on a user's behalf.
 *
 * Major.minor only. A browser User-Agent that moves on every patch is a
 * fingerprinting signal, and the patch number tells a web server nothing it
 * could act on.
 */
export const HUSK_BROWSER_USER_AGENT = `husk-browser/${HUSK_VERSION.split('.').slice(0, 2).join('.')} (+${HUSK_REPO})`;
