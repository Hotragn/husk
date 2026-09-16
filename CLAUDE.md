# Husk

TypeScript monorepo — 11 npm packages + 3 apps giving AI agents disposable Linux computers.

Read these before writing code. They are the source of truth and this file does not repeat
them:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, tests, the build contract, code-review
  values, commit style, and the traps that make a tool lie to you
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, the computer, provider selection,
  the agent loop, deliberate non-goals
- [`docs/BUILD-CONTRACT.md`](docs/BUILD-CONTRACT.md) — the rules every package obeys
- [`docs/diagrams/`](docs/diagrams/) — sixteen diagrams. Where a diagram and a doc disagree,
  the diagram follows the code.

What follows is only the things none of those cover.

```bash
npm run build       # explicit topological order, not npm workspaces default
npm run typecheck
npm test
npm run drift       # duplicated facts still agree
npm run preflight   # read-only publish checks
```

`apps/docs` and `apps/web` are outside the workspace — own lockfiles, `cd` in and
`npm install` on demand. A root `npm install` covers `packages/*` and `apps/console` only.

## Verifying work

Check the artifact, never the exit status. Four defects reached or nearly reached users
this way:

- `@husk-ai/cli@0.1.1` exited 0 and printed zero bytes
- `gh issue edit` with a bad path exited 0 and changed nothing
- `exposePort` returned a URL with nothing listening on it
- a release run reported success while the registry still 404'd four packages

Two traps behind that last one. npm's read path is eventually consistent and can 404 a
just-published version for minutes — the publish log (`+ @husk-ai/<pkg>@<v>`) is the record,
a registry GET is not. And `npm audit signatures --json` emits only `invalid` and `missing`;
it confirms nothing failed but never enumerates what it checked, so "all 11 have provenance"
needs each attestation decoded individually.

## The four guards

Each checks a different layer. None substitutes for another.

| Guard | Checks |
| --- | --- |
| `npm run drift` | source copies of one fact still agree with each other |
| `npm run preflight` | manifests, publish order and registry state, before publishing |
| `pack.test.ts` | the *installed* binary prints what its manifest claims |
| `scripts/secret-scan.mjs` | every ref, tree and full history |

Integration tests are opt-in behind `HUSK_INTEGRATION=1`, so a green suite does not mean
Docker was exercised. The Windows job skips the `local` free-path test on every run — issue
#63 — so that path has no CI coverage on the platform it matters most for.

## Duplicated facts

The recurring defect here is a fact with more than one home and no link between the copies:
`husk.sh` across four User-Agent strings, the security contact in two branches, `REPO_URL`
in two apps, a version literal in a test.

The ruling is to make copies observable to each other rather than always eliminating them.
`scripts/drift-check.mjs` is that observer, and root `package.json`'s `repository.url` is the
arbiter every other copy is compared against.

Its assertion count is not a score. Each assertion admits a fact that could not be given a
single home, so the count going *down* because something became derivable is the progress.

## Merging

- **Merge commits only.** Squash and rebase merges are disabled in settings: both rewrite a
  SHA and break any PR stacked on it.
- GitHub's CLEAN means no textual conflict and nothing more. Trial-merge locally whenever a
  PR touches a file another PR just merged.
- Mergeability is computed asynchronously. A single read can catch it mid-flight.
- **Never resolve a conflict with `--ours`/`--theirs` across files.** Conflict markers show
  which lines disagree, never how many facts those lines encode. In `core/src/config.ts` and
  `models/src/http.ts` the version and the repo URL were one literal, so neither side was
  right and only a hand-merge was.
- A hunk's fact-arity changes between merge steps: resolving one step can consume a fact. A
  resolution table derived once is not reusable across steps, or across a moved `main`.
- After any hand-merge, `npm run drift` must pass. It has caught a bad resolution twice.

## Releasing

Ship when there is a user-visible fix or feature. Guards, refactors and docs ride along with
the next release that has a reason of its own.

1. One commit bumps everything: 15 manifests, 28 cross-workspace pins, the version constants
   drift-check enforces, `docs/API.md`, and **all three lockfiles** — the two out-of-workspace
   sites each need their own `cd` and `npm install --package-lock-only`.
2. `npm run preflight`.
3. Tag at an explicit SHA, never at `HEAD`.
4. `release.yml` publishes in dependency order, then creates the GitHub Release.
5. Verify from outside the repo: `npx -y @husk-ai/cli@X.Y.Z doctor`.

Every cross-workspace pin is exact, so publishing out of dependency order produces an
immediate `notarget`. npm has no undo, only "publish something newer".

## Secrets and history

`scripts/secret-scan.mjs` uses `git log -p --all`, so it reaches every ref including a second
root. Its coverage is exactly "reachable from a ref".

Deleting a branch or force-pushing removes commits from the scanner and from nobody else —
GitHub serves unreachable commits by SHA indefinitely. **Deletion is concealment from your
own tooling, not remediation.** Scan before deleting an unmerged ref.

`--all` includes `refs/stash`, so a stash entry can be the only thing holding a commit in
scope. `stash@{1}` and older live in a reflog and are never scanned.

A clean scan means nothing without its scope — record the ref set and the commit count.
Force-push audit clean as of 2026-09-16 across the repo's entire history: four force-pushes,
every orphaned commit scanned while still reachable, all passing.

## Environment

- **Never `git stash` here.** The stash is shared across every worktree. Use a throwaway
  worktree instead.
- On Windows the `local` provider uses WSL2 for a real Linux `/work`. With WSL unhealthy it
  degrades to the Windows shell *and* Docker Desktop fails too, because its engine runs
  inside WSL2. One root cause, two dead providers.
- `git worktree list` before opening another. Stale worktrees cause "branch already checked
  out" and failed deletions.

## Working in parallel

Sessions are scoped by directory, not by task:

| Owner | Directory |
| --- | --- |
| maintainer | `packages/*`, releases |
| website | `apps/web` |
| console | `apps/console` |
| docs | `apps/docs` |
| infrastructure | `.github/`, repo settings |

Only the maintainer touches root manifests or lockfiles, and version bumps are the
maintainer's alone.

Findings belong in the repo, not a chat thread — a PR comment, an issue, or this file. A
precondition written against a proxy ("the bump merged") rather than the condition itself
("the release shipped") is a stale gate with nobody watching it.

Machine-local and maintainer-private work stays out of the repo and is gitignored:
`.claude/`, `.agents/`, `skills-lock.json`, `launch/`. Before adding a file at the root, ask
whether a contributor cloning this repo needs it. If the answer is no, ignore it rather than
committing it and tidying later — history is the one thing you cannot tidy.

## Deciding

When nothing above reaches, these are the heuristics that have worked here.

- **Verify before asserting.** Check the file, the API response, the installed binary. Every
  bad call this repo has seen came from reasoning off memory instead of looking.
- **Prefer a mechanical guard to a remembered step.** A draft PR that enforces ordering, a
  setting that removes the wrong button, a gate written as a command you can run.
- **Don't write down what you can't reproduce.** A rule for an unreproduced failure sends the
  next person chasing a ghost and devalues the rules beside it.
- **Reversibility sets the caution level.** npm has no undo; a merge does.
- **Never change a mechanism in the same breath as using it.** Release machinery changes land
  a version before the release that relies on them.
- **Scope discipline beats completeness.** A patch release fixes the thing it exists to fix.
- **State your own errors plainly and continue.** Reports are trustworthy because they include
  what went wrong.
- **A ruling that turns out wrong gets reversed out loud**, with the reason.

## Writing

Commit and PR style is in [`CONTRIBUTING.md`](CONTRIBUTING.md#commits) — follow it.

**No AI attribution, co-author lines, or generated-by trailers anywhere**: commits, PR
bodies, comments, issues, release notes, code comments, docs, the website. This is written
down because agent harnesses ship defaults that add them, so without an explicit override
here every fresh session reintroduces them.
