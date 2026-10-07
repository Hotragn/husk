# Husk 0.2.0: one-day delivery and launch plan

Prepared 6 October 2026. Scope: one focused implementation day, with a release
candidate that a beginner can use to turn public sources into a saved result.

## Product decision

Lead with **“Keep your AI work: sources, results, and a place to return to.”**
The first audience is people already using an AI desktop app for research and
small decisions. Their first task is a cited brief from a few public pages.
Success means they can finish, inspect, export, and reopen it without shell setup.

This is a product hypothesis, not a claim of validated demand. Generic file and
terminal access is already available through [Desktop Commander](https://claude.com/marketplace/connectors/desktop-commander),
while [Claude Projects](https://support.claude.com/en/articles/9517075-what-are-projects)
organizes related chats and context. Husk's initial value should therefore be an
explicit, portable record of sources and outputs, with optional computer tools.
Do not position it as a replacement for a complete AI chat app.

## One day, eight hours

| Time | Deliverable | Acceptance |
| --- | --- | --- |
| 0–1 h | Inspect existing flows and user reports; choose one first task | Clear audience, useful outcome, limits, primary sources |
| 1–3 h | Durable workspace and public-source capture | Restart reopens files; invalid paths and private network targets refused |
| 3–5 h | Beginner Home and starter MCP profile | Create → sources → prompt → review → download, without computer setup |
| 5–6 h | Reliability repairs | Unsupported triggers explain themselves; local model choice stable; browser prerequisites visible |
| 6–7 h | Installer, packaging and regression checks | Extracted archive runs independently; data survives reconnect; downloads work |
| 7–8 h | First-task guide, launch copy and usability handoff | Honest release status; small beta task and measurement sheet ready |

This schedule sets the delivery scope. Actual work spanned interrupted sessions;
it is not a claim that eight hours of elapsed time or user testing has already occurred.

## Implemented changes and why

| Change | Why it helps users | Evidence or constraint |
| --- | --- | --- |
| Eight workspace tools and a starter profile | Users can keep work without provisioning a machine | Existing CLI/MCP onboarding required technical choices; starter needs only the AI host |
| `.mcpb` extension with packaged production dependencies and viewer assets | Removes terminal and dependency installation from the user flow | [Claude extension documentation](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) supports custom bundles and supplies Node |
| Named workspaces with atomic writes, recovery journal, and process locks | Saves results durably across restarts and concurrent chats | Persistence, corruption, symlink, traversal and concurrent-write tests |
| Public URL capture with source IDs, dates, text, and hashes | Users can inspect the evidence behind an output | Text-only fetching is deliberately bounded; citations still require review |
| Three prompts: brief, comparison, actions | Gives beginners a concrete first task without another model subscription | AI synthesis remains in the connected host; viewer does not pretend to generate it |
| Local viewer with authenticated downloads and ZIP export | Makes saved work visible and portable | Packaged archive checks exercise assets, auth, read, download and export |
| Advanced provider review and explicit enablement | Makes command access and actual isolation understandable | [MCP tools guidance](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) recommends clear exposed capabilities; provider is rechecked before enabling |
| Named MCP computers stop on disconnect | Prevents accidental destruction of files intended for reuse | Dedicated lifecycle regression tests |
| Unsupported messaging triggers fail validation | Replaces silent non-functionality with an actionable error | [Issue 114](https://github.com/Hotragn/husk/issues/114) |
| Confirmed model capabilities and deterministic default ordering | Avoids choosing the first tiny local model merely because it is listed first | [Issue 121](https://github.com/Hotragn/husk/issues/121); size tier is a heuristic, not a quality benchmark |
| Sequential distillation, failure cutoff, accurate extraction notes | Reduces repeated failed model calls and explains fallback | Failed extraction reports attempted model and heuristic result |
| Browser prerequisite inspection before downloads | Explains unavailable environments before spending time downloading | [Issue 122](https://github.com/Hotragn/husk/issues/122) |
| Beginner documentation and narrower claims | Helps users distinguish workspaces, computers, host AI processing, and site analytics | Installed product has no telemetry; hosted sites use [Vercel Web Analytics](https://vercel.com/docs/analytics/privacy-policy) |

## Verification and release boundary

Local checks are recorded in `build/test-run.log`, `build/typecheck.log`, and the
final handoff. The archive smoke test launches the extension after official MCPB
extraction into a separate temporary directory; it cannot borrow the checkout's
dependencies. `--online` additionally captures three real public sources.

The `starter.yml` workflow builds one archive and tests that same artifact across
Windows, macOS, and Linux on Node 20 and 22. Release publishing depends on this gate
and attaches the archive plus SHA-256 checksum. The
[release dry run](https://github.com/Hotragn/husk/actions/runs/37559726026) passed
the platform matrix, package build, typecheck, tests, registry collision preflight,
and tarball checks. It also verified the configured npm token's identity before the
longer work. The identity check does not prove publish permission. The dry run
published nothing. Use the [official MCPB tooling](https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md)
for validation, packing, and signing.

The delivered local candidate is **unsigned and unpublished**. An actual install
inside Claude Desktop and beta outcomes must be observed before calling this
generally available. Public release, directory submission, and any
signing identity remain release-owner actions. No new accounts, paid services,
community posts, or outreach were made by this implementation.

## Traction work ready to run on launch day

1. Demonstrate one real task: capture three sources, create a brief, inspect a claim,
   download it, then reopen the workspace in a new chat. Record failures as well as
   successes. Do not substitute a seeded output for an AI-generated demo.
2. Invite five willing existing AI users to perform that same task independently.
   Include at least two people who do not use a terminal. Use their public test
   sources; do not collect private documents or credentials.
3. Observe install completion, first saved result, exported result, and a second task.
   Count assisted and unassisted completions separately. Target four of five users
   completing the first task without developer help; this is a launch threshold,
   not a measured result.
4. Fix the most frequent blocker before adding more features. If installation fails,
   improve distribution. If users cannot get a useful result, improve the handoff
   and prompts. If they do not return for another task, revisit the target use case.
5. Publish the verified artifact, a short first-task guide, known limits, and an honest
   demo. Then submit the extension through the directory's current submission process.
   Start with relevant existing communities and useful examples; do not mass-message.

### Minimal measurement sheet

Record only volunteered, non-sensitive observations locally. No hidden telemetry is added.

| Participant alias | OS / host version | Installed | First result minutes | Unassisted? | Exported | Second task | Main blocker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| To be observed | — | — | — | — | — | — | — |

Downloads and stars are acquisition signals, not active users. The meaningful
measure is a useful completed task followed by another task. Traction cannot be
guaranteed or established by a code change alone.

## Release notes draft

Husk 0.2.0 introduces local workspaces for sources and AI results. Start with a
cited brief, comparison, or action list; inspect source captures, save results,
export a ZIP, and reopen your work later. The desktop starter profile needs no
Docker or extra model API key. Computer tools are available after reviewing the
provider. This release also improves local model selection, failed distillation,
browser setup feedback, and named-session persistence.

Limits: public text sources only; no signed-in browsing in the starter flow,
binary uploads, team sharing, cloud sync, or automatic ZIP import. AI outputs still
need review. See the workspace guide for storage limits and privacy.
