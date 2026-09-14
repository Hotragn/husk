# Diagrams

Sixteen diagrams of husk, generated with [archify](https://github.com/tt-a1i/archify).

Each one is a pair: a typed JSON specification and a self-contained HTML viewer.
Open the `.html` in a browser — it needs no server and no network. Pan/zoom,
light/dark, search, relationship tracing and PNG/SVG export are built in.

Every box maps to a real file or package. Where a diagram and a doc disagree,
the diagram follows the code.

## The five that have a job

| # | Diagram | Belongs at the top of | Job |
| --- | --- | --- | --- |
| 01 | [Hero](01-hero.html) | `README.md` | Make the value obvious in five seconds |
| 02 | [System architecture](02-system-architecture.html) | `docs/ARCHITECTURE.md` | Orient a contributor |
| 03 | [Provider ladder](03-provider-ladder.html) | `apps/docs/content/computers/providers.mdx` | Sell the free path |
| 04 | [chat → bot](04-chat-to-bot.html) | `apps/docs/content/chat-to-bot/distiller.mdx` | Explain the second product |
| 05 | [Trust boundaries](05-trust-boundaries.html) | `docs/SECURITY-MODEL.md` | Survive a security review |

## Data-flow decomposition

| # | Diagram | Scope |
| --- | --- | --- |
| 06 | [DFD level 0](06-dfd0-context.html) | Context — actors, the process, what it touches |
| 07 | [DFD level 1](07-dfd1-subsystems.html) | The subsystems |
| 08 | [DFD level 2](08-dfd2-computer-manager.html) | Inside the computer manager |
| 09 | [DFD level 3](09-dfd3-shell-call.html) | One `shell` call on the `local` provider |

## Design and structure

| # | Diagram | Scope |
| --- | --- | --- |
| 10 | [Use cases](10-use-cases.html) | Actors and the goals they reach |
| 11 | [High-level design](11-hld-runtime.html) | Processes, ports and boundaries |
| 12 | [Low-level design](12-lld-mcp-shell-call.html) | One MCP `shell` call, end to end |
| 13 | [UML — core contracts](13-uml-core-contracts.html) | The types in `@husk/core` |
| 14 | [UML — provider hierarchy](14-uml-provider-hierarchy.html) | `OciProvider` and the five providers |
| 15 | [Computer lifecycle](15-computer-lifecycle.html) | The `ComputerState` machine |
| 16 | [Test topology](16-test-topology.html) | 78 test files, two vitest configs |

## Regenerating

```bash
node ~/.agents/skills/archify/bin/archify.mjs deliver architecture docs/diagrams/02-system-architecture.architecture.json docs/diagrams/02-system-architecture.html --quality showcase --repo-root .
```

Pass the matching type (`architecture`, `workflow`, `sequence`, `dataflow`,
`lifecycle`). `--repo-root .` is required for, and only supported by, the
architecture diagrams — they are the ones that declare `sources` evidence, which
is resolved against the working tree at render time.

All sixteen pass `--quality showcase` with 9/9 artifact checks, 0 composition
errors and 0 warnings, and `visual-check` clean at 1440×900 through 2048×1320 in
both themes.

## One place the code and the docs disagree

`docs/ARCHITECTURE.md` describes `@husk/mcp` as "stdio + streamable HTTP" and
says the same server runs over streamable HTTP for remote clients. It does not.
`packages/mcp/src/server.ts:139` constructs a `StdioServerTransport` and that is
the only transport in the package; `docs/SPEC-remote-mcp.md` records the remote
transport as *proposed, not started* and names that same line as the blocker.
Diagrams 01, 02, 11 and 12 draw stdio only.
