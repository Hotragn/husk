# Husk documentation handoff: one day

Prepared 9 October 2026. Give this file to Claude as the task brief. Finish the
documentation and launch-copy pass in one working day. Use the current repository,
the public 0.2.0 preview release, and current primary sources to verify claims.
Keep the work inside this one-day scope.

## Current product truth

- Lead with **“Your AI chat gets a computer.”** Explain the shell, files, and
  browser, then show that named local workspaces keep public sources and results.
- The [0.2.0 public preview](https://github.com/Hotragn/husk/releases/tag/preview-0.2.0)
  is an unsigned Claude Desktop extension. Its starter profile begins with
  workspace tools. Computer tools require an explicit provider review and opt-in.
- The preview is not evidence of completed independent user testing. Check the
  release and current code before claiming installation, reliability, or adoption.
- The installed runtime has no product telemetry. The hosted website and docs use
  web analytics. AI-host limits apply, and tasks may contact selected sources and
  model providers.
- `local` has guardrails but is not a security sandbox. State the actual provider
  and isolation whenever discussing computer access.
- The available npm packages and the desktop extension are different install
  paths. Check package versions and release assets before writing commands.

## Files to update, in order

| Priority | Files | Result |
| --- | --- | --- |
| 1 | `README.md`, `apps/docs/content/start/index.mdx`, `apps/docs/content/start/install.mdx` | One consistent product explanation and a clear choice between the beginner desktop flow and the developer computer flow. |
| 2 | `apps/docs/content/start/workspaces.mdx`, `apps/docs/content/start/quickstart.mdx`, `apps/docs/content/mcp/index.mdx` | Testable first-task steps, accurate prerequisites, exact commands, and recovery when the viewer or provider is unavailable. |
| 3 | `apps/docs/content/start/doctor.mdx`, `apps/docs/content/troubleshooting.mdx` | Replace stale versioned sample output and check every diagnostic against the current CLI. Label illustrative examples. |
| 4 | `docs/RELEASING.md`, `CHANGELOG.md` | Separate the 0.2.0 preview bundle from npm publication; document the actual release gate and current release state. |
| 5 | `brand/voice-examples.md`, `brand/UI-PRINCIPLES.md` | Replace the old selected headline and obsolete section references with the current tagline and page structure. |
| 6 | `launch/*.md` | Update install commands, tagline, links, demo path, limits, and calls to action. Keep drafts unpublished until the claims and first-task demo are verified. |
| 7 | `Husk go-to-market plan.md` (local draft, if present) | Rewrite the old 0.1.3 launch plan into a concise same-day execution brief. Remove long-range schedules, stale metrics, obsolete blockers, and unverified competitor claims. Preserve useful research only after rechecking it. |

`Husk QA and refinement roadmap.md` is historical test evidence. Keep its dated
findings intact and link to current checks instead of editing old results as if
they were newly measured. `docs/one-day-delivery.md` records the 0.2.0 delivery
decision and release boundary; keep it aligned with any changed release facts.

## Same-day execution

1. **Audit:** compare each claim with current code, the GitHub preview release,
   npm registry, and official platform documentation. Record any mismatch.
2. **Fix the first-use path:** make the README and Start pages agree on who each
   install path is for. Follow the steps on a clean machine or label them untested.
3. **Fix reference and release copy:** update diagnostic examples, version labels,
   release state, limits, isolation language, and analytics wording.
4. **Fix launch copy:** use one honest demo: install, capture public sources, make
   a cited result, inspect and export it, then reopen the workspace. Include the
   separate computer-tool path. Do not claim user traction without observations.
5. **Verify and hand back:** run `npm run links`, `npm run drift -- --sites`, docs
   build, and a search for stale package scopes, versions, and old taglines. Give
   a short changed-files summary, source links for time-sensitive claims, and
   unresolved facts that need a real user or release owner.

## Definition of done

The first page a beginner reads has one obvious action. A developer can find the
computer setup without confusing it with the starter extension. Commands and
downloads resolve. Every public claim matches current behavior or is explicitly
marked as a preview limit. The handoff contains no promises based on elapsed
calendar time; publish only after a real first-task check.
