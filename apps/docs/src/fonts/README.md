# Fonts

Three faces, self-hosted, declared by `next/font/local` in
[`../../app/fonts.ts`](../../app/fonts.ts).

Nothing here is fetched at runtime from anyone else's origin. A product whose
pitch is that nothing leaves your machine has no business handing every
reader's IP address to a font CDN, so there is no `next/font/google` and no
`<link>` to `fonts.googleapis.com` on either site.

| File | Face | Licence | Where it is used |
| --- | --- | --- | --- |
| `GeneralSans-Variable.woff2` | General Sans, wght 200–700 | ITF Free Font License 2.0 | display and UI, every page |
| `GeneralSans-VariableItalic.woff2` | General Sans Italic | ITF FFL 2.0 | emphasis |
| `CommitMono-Variable.woff2` | Commit Mono, wght 200–700 | MIT | anything a machine wrote |

The ITF FFL grants self-hosting explicitly — "Self-hosting by end users is
permitted and recommended for greater control, reliability and performance."
Licence texts sit beside the files.

## What was done to these files

Each was instanced and subset with `fontTools` before being committed, which is
why none of them matches the byte count of the upstream download:

- **Axes nobody sets are instanced out.** Commit Mono ships an `ital` axis this
  site never uses.
- **Subset to latin**, plus, for the mono face, the arrows, box-drawing,
  block-element, geometric-shape and dingbat ranges. Those are not decoration:
  the terminal transcripts on both sites print `─ │ ┌ ✓ ✗ ▶ ≤`, and a subset
  that dropped them would render real output in a fallback face.

The stack is 95K, against 291K for the three faces it replaced. There is no
serif here: Newsreader exists for one essay on the marketing site.

**One known gap.** Commit Mono has no glyph at U+26A0. `husk run`'s approval
prompt prints one — see `packages/cli/src/commands/run.ts` — so the single
place the docs quote that prompt shows one character in a fallback face. Quoted
output stays quoted; the alternative was editing a real transcript.

## Regenerating

If a face is updated upstream, re-run the subset rather than committing the raw
download. The ranges above are the contract.
