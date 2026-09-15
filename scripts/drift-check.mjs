#!/usr/bin/env node
/**
 * The drift check.
 *
 * Some facts in this repo are written down in more than one place, because the
 * alternative is worse: the docs site cannot import from `packages/core`, and a
 * stylesheet cannot import a stylesheet it has to ship standalone. Duplication
 * is the trade, and this script is the price of it.
 *
 * It exists because of two bugs that shipped. `http-referer: https://husk.sh`
 * went out in an attribution header for months with a test asserting the same
 * wrong literal -- two files agreeing with each other and with nothing else.
 * And `husk --version` still prints a version no package is on.
 *
 * A duplicated fact with no check is a fact that is already wrong and has not
 * been noticed yet. Every invariant below is one a human would otherwise have
 * to remember.
 *
 * The goal is not fewer copies. `REPO_URL` lives in both site config files, and
 * two small Next apps each owning their own constants file is normal --
 * extracting one string into a shared package would couple `apps/*` to
 * `packages/*` for no other reason than to have one copy of it. This check
 * exists so duplication can be safe, not so duplication can be avoided. The
 * copies do not need to be fewer; they need to be observable to each other.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** The single source of truth for the version. Everything else must agree. */
export const VERSION = JSON.parse(read('package.json')).version;

/**
 * A browser User-Agent carries major.minor only. Patch-level churn is a
 * fingerprinting signal and tells a server nothing it can act on.
 */
const MAJOR_MINOR = VERSION.split(".").slice(0, 2).join(".");

/**
 * The two sites live outside the npm workspace, so a typo in either must not
 * gate a runtime fix -- that is the friction scoping the install just removed.
 * Their invariants run under `--sites` as a separate, non-required CI job:
 * visible, not blocking.
 */
const SITES_ONLY = process.argv.includes("--sites");

const failures = [];
const passes = [];

/**
 * `file` must contain `needle` verbatim.
 *
 * `hint` names the fix, the way `HuskError` does -- a failure that does not say
 * what to edit just moves the puzzle.
 */
function contains(file, needle, hint) {
  const label = `${file} contains ${JSON.stringify(needle)}`;
  if (read(file).includes(needle)) passes.push(label);
  else failures.push({ label, hint });
}

/** `file` must NOT contain `needle` -- for facts that were wrong and stay wrong. */
function absent(file, needle, hint) {
  const label = `${file} is free of ${JSON.stringify(needle)}`;
  if (!read(file).includes(needle)) passes.push(label);
  else failures.push({ label, hint });
}

/** Two files must be byte-identical. Vendored copies drift silently otherwise. */
function identical(source, copy) {
  const label = `${copy} is byte-identical to ${source}`;
  if (read(source) === read(copy)) passes.push(label);
  else failures.push({ label, hint: `cp ${source} ${copy}` });
}

/* -----------------------------------------------------------------------------
   The design system. `brand/tokens.css` is the source; each app ships a copy
   because a Next app cannot import a stylesheet from outside its own tree.
-------------------------------------------------------------------------------- */
for (const copy of [
  'apps/console/src/styles/tokens.css',
  'apps/docs/src/styles/tokens.css',
  'apps/web/src/styles/tokens.css',
]) {
  identical('brand/tokens.css', copy);
}

/* -----------------------------------------------------------------------------
   Project identity, as a chain rather than a deny list.

   `absent(file, 'husk-sh/')` was never the copies observing each other. It was
   every copy checked against one specific wrong answer we had already made, and
   the next drift will not be that answer -- a deny list has nothing to say
   about a value nobody predicted.

   So: the root manifest is the arbiter, every other copy is asserted equal to
   it, and `absent` survives only where nothing is derivable. Eleven published
   manifests plus two site files carry this URL. They agree today by diligence.
-------------------------------------------------------------------------------- */

/** The one arbiter for where this project lives. */
const REPO_GIT = JSON.parse(read('package.json')).repository?.url;
if (REPO_GIT) {
  passes.push(`package.json declares repository.url (${REPO_GIT})`);
} else {
  failures.push({
    label: 'package.json declares repository.url',
    hint: 'the root manifest arbitrates where this project lives -- without it every other copy is judged by an arbitrary twelfth',
  });
}

/** The human-facing form: what a source file, a README or a link carries. */
const REPO = (REPO_GIT ?? '').replace(/.git$/, '');

if (REPO_GIT) {
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const rel = `packages/${dir}/package.json`;
    let url;
    try {
      url = JSON.parse(read(rel)).repository?.url;
    } catch {
      continue;
    }
    const label = `${rel} repository.url equals the root's`;
    if (url === REPO_GIT) passes.push(label);
    else failures.push({ label, hint: `expected ${REPO_GIT}, found ${url ?? 'nothing'}` });
  }

  // Shipped code that names the repo, asserted positively. A file carrying the
  // wrong URL fails this whatever the wrong URL turns out to be, which is the
  // whole difference from the deny list it replaces.
  //
  // The next three are a holding pattern, not the design. #62 derives the user
  // agent as `husk/${VERSION} (+${REPO})`, and then there is no literal here to
  // assert: the string comes from two single-homed facts. They will keep passing
  // after that change, because the derived string contains the same substring,
  // so they have to be deleted deliberately rather than left to fail.
  const operator = `the (+URL) in a user agent names the operator; use ${REPO}`;
  contains('packages/core/src/config.ts', `(+${REPO})`, operator);
  contains('packages/core/src/browse.ts', `(+${REPO})`, operator);
  contains('packages/models/src/http.ts', `(+${REPO})`, operator);
  contains(
    'packages/models/src/providers/compatible.ts',
    `'http-referer': '${REPO}'`,
    `OpenRouter attributes traffic by this header; use ${REPO}`,
  );
  contains(
    'SECURITY.md',
    `${REPO}/security/advisories/new`,
    "the disclosure channel has to be this repository's",
  );
}

// Prose, where there is no string to equal. A deny list is all there is here,
// and it only knows about the mistake already made.
absent('CODE_OF_CONDUCT.md', 'husk.sh', 'that domain is not ours');
absent('CODE_OF_CONDUCT.md', 'husk-sh/', 'that GitHub org is not ours');

/* -----------------------------------------------------------------------------
   The version. package.json is the source; every file below hardcodes it.

   Each assertion pins the version *fragment*, never the whole literal. The
   invariant is "the version here matches the manifests", not "this string is
   exactly this" -- a check that fires when someone legitimately edits the URL
   or adds a field is a check someone disables.
-------------------------------------------------------------------------------- */
if (!SITES_ONLY) {
  const bump = `package.json is on ${VERSION}; bump this to match`;
  contains("packages/cli/src/version.ts", `VERSION = '${VERSION}'`, bump);
  contains("packages/core/src/index.ts", `HUSK_VERSION = '${VERSION}'`, bump);
  // These three go with #62 for the same reason as the repo-URL assertions
  // above: once the user agents interpolate ${VERSION}, they assert a substring
  // of a string that can no longer disagree with the manifest.
  contains("packages/core/src/config.ts", `husk/${VERSION}`, bump);
  contains("packages/models/src/http.ts", `husk/${VERSION}`, bump);
  contains("packages/core/src/browse.ts", `husk-browser/${MAJOR_MINOR}`, bump);
  // docs/API.md is the control-plane contract, not a website: the example
  // payload has to show the version the server actually returns.
  contains("docs/API.md", `"version": "${VERSION}"`, bump);
}

/* -----------------------------------------------------------------------------
   The sites. Non-required: run with `--sites`.
-------------------------------------------------------------------------------- */
if (SITES_ONLY) {
  // Two copies of one fact, linked to the arbiter rather than to each other.
  if (REPO_GIT) {
    const derive = `derive it from the root manifest: ${REPO}`;
    contains('apps/docs/src/lib/site.ts', `REPO_URL = '${REPO}'`, derive);
    contains('apps/web/src/lib/content.ts', `REPO_URL = "${REPO}"`, derive);
  }
  // Not derivable: SITE_URL reads NEXT_PUBLIC_SITE_URL now, so the requirement
  // is that no domain is hardcoded at all, which only an absence can say.
  absent('apps/web/src/lib/content.ts', 'husk.sh', 'SITE_URL reads NEXT_PUBLIC_SITE_URL; no domain belongs here');
  contains(
    "apps/docs/src/lib/site.ts",
    `HUSK_VERSION = '${VERSION}'`,
    `package.json is on ${VERSION}; the docs must not describe an older one`,
  );
}

/* ---------------------------------------------------------------------------- */

for (const p of passes) console.log(`  ok    ${p}`);
for (const f of failures) console.error(`  DRIFT ${f.label}\n        fix: ${f.hint}`);
console.log(`\n${passes.length} ok, ${failures.length} drifted (version ${VERSION})`);
process.exit(failures.length ? 1 : 0);
