# Husk: documentation issues I noticed

Please fix these in one pass today. You already know Husk and the repository;
this is a list of mismatches I found, not a new product brief.

1. **The selected headline is inconsistent.** The website and `brand/BRAND.md`
   now use “Your AI chat gets a computer.” `brand/voice-examples.md` still picks
   “Give your agent a computer,” and `brand/UI-PRINCIPLES.md` still refers to
   “Husk does two things” although the homepage now shows three. Align those
   files with the current page; keep the user's tagline exact.

2. **The install page skips the desktop path.**
   `apps/docs/content/start/install.mdx` says there is no installer and lists
   only npm/CLI/MCP routes. `apps/docs/content/start/workspaces.mdx` separately
   explains the desktop extension. Make the choice between those routes obvious
   from Install and Start, without making either route sound required for the
   other. Check `apps/docs/content/start/index.mdx` and the relevant README links.

3. **Doctor examples show an old version.**
   `apps/docs/content/start/doctor.mdx` contains `husk 0.1.0` in its text and JSON
   examples; `brand/voice-examples.md` also shows `husk 0.1.0`. Update or clearly
   label illustrative output after checking the current CLI. Check related
   troubleshooting examples for the same drift.

4. **Release docs do not explain the current preview path.** `docs/RELEASING.md`
   describes the npm package release sequence, while the 0.2.0 desktop preview
   was distributed separately. `CHANGELOG.md` has no 0.2.0 entry and its
   Unreleased comparison starts at `v0.1.4`. Decide how the preview should be
   recorded, then make the release instructions and changelog agree with what
   actually shipped. Do not imply an npm 0.2.0 publication occurred.

5. **Launch copy is dated.** `launch/blog-draft.md` opens with the old headline.
   `launch/launch-checklist.md` uses a pre-launch and Week 1 schedule and assumes
   a package launch. The local `Husk go-to-market plan.md`, if available, is
   written against 0.1.3 and contains long-range timing and obsolete blockers.
   Replace those schedules with actions that can be executed today. Remove claims
   and numbers that have not been rechecked; preserve useful material only where
   it still matches the current release.

Please make the edits rather than return another plan. Verify commands, links,
version labels, and time-sensitive claims, then send me a short list of what you
changed and anything that still needs a real install or user observation.
