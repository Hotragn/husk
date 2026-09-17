# Husk — releasing

Eleven packages publish together, at one version, in dependency order. Every
cross-workspace pin is exact, so the order is not a preference: publishing a package
before something it depends on produces an immediate `notarget` for anyone installing
in between.

npm has no undo. The only correction is publishing something newer.

## When to ship

Ship when there is a user-visible fix or a user-visible feature. Guards, refactors and
documentation ride along with the next release that has a reason of its own — they are
not reasons themselves.

A patch release fixes the thing it exists to fix. Widening it is how a fix acquires a
regression it did not need.

**Never change the release machinery in the same breath as using it.** A change to
`release.yml`, to the publish order, or to how authentication works lands in one
release and is relied on by the next. `0.1.3` created its GitHub Release automatically
because that step had been sitting on `main`, unused, since `0.1.2`.

## The sequence

1. **One commit bumps everything.** Fifteen manifests, twenty-eight cross-workspace
   pins, the version constants the drift check enforces, `docs/API.md`, and **all three
   lockfiles** — `apps/docs` and `apps/web` are outside the workspace, so each needs its
   own `cd` and `npm install --package-lock-only`. A root install does not reach them.

2. **`npm run preflight`.** Read-only: manifests, publish order, and what the registry
   already has.

3. **Tag at an explicit SHA**, never at `HEAD`. `HEAD` moves; a release is a point.

4. **`release.yml` publishes in dependency order**, then creates the GitHub Release.

5. **Verify from outside the repo**, against the registry rather than the workflow:

   ```bash
   npx -y @husk-ai/cli@X.Y.Z doctor
   ```

   Run it from a directory that is not this one. Node resolves a bare specifier by
   walking up from the script's location, so a check run inside the checkout can bind
   the workspace copy and report on your working tree instead of on what shipped.

## Two ways the registry will lie to you

**npm's read path is eventually consistent.** A `GET` for a version you just published
can 404 for minutes. The publish log line — `+ @husk-ai/<pkg>@<version>` — is the
record that it happened. A registry read is evidence of propagation, not of publication,
and treating a 404 as a failed publish is how a release gets attempted twice.

**`npm audit signatures --json` only reports problems.** It emits `invalid` and
`missing` and enumerates nothing that passed, so a clean run means "nothing failed",
not "all eleven have provenance". Confirming provenance means decoding each
attestation individually.

Both of these belong to a wider rule: **check the artifact, never the exit status.**
Four defects in this repo reached or nearly reached users through a command that
succeeded while doing nothing — see
[Verifying work](../CONTRIBUTING.md#verifying-work).

## After the release

`CHANGELOG.md` gets the section for the version that just shipped, written for someone
deciding whether to upgrade. The symptom they would have hit, not the files that moved.
