# Fonts

This directory is empty on purpose, and the site renders correctly without it.

Husk's three faces — Bricolage Grotesque (display), Instrument Sans (UI) and
JetBrains Mono (machine speech) — are all SIL Open Font License 1.1. They are
**not** vendored in this repository, and the site does **not** load them from
the Google Fonts CDN or any other third-party origin. A product whose pitch is
that nothing leaves your machine should not open a connection to `fonts.gstatic.com`
on its own homepage.

Until the woff2 files are here, `--font-display`, `--font-ui` and `--font-mono`
resolve to the fallback stacks declared in `src/styles/tokens.css`, which were
chosen for exactly this case ("metric-adjacent enough that swap does not cause
a visible reflow at body sizes"). Every fallback in the mono stack keeps a
slashed or dotted zero, so terminal output stays unambiguous.

## Completing the self-hosting

Put these three variable woff2 files in this directory:

```
BricolageGrotesque[opsz,wdth,wght,GRAD].woff2
InstrumentSans[wdth,wght].woff2
JetBrainsMono[wght].woff2
```

Then add `src/styles/fonts.css`:

```css
@font-face {
  font-family: "Bricolage Grotesque";
  src: url("/fonts/BricolageGrotesque[opsz,wdth,wght,GRAD].woff2") format("woff2");
  font-weight: 200 800;
  font-stretch: 75% 100%;
  font-display: swap;
}

@font-face {
  font-family: "Instrument Sans";
  src: url("/fonts/InstrumentSans[wdth,wght].woff2") format("woff2");
  font-weight: 400 700;
  font-stretch: 75% 100%;
  font-display: swap;
}

@font-face {
  font-family: "JetBrains Mono";
  src: url("/fonts/JetBrainsMono[wght].woff2") format("woff2");
  font-weight: 100 800;
  font-display: swap;
}
```

and one line at the top of `src/app/globals.css`, directly under the tokens
import:

```css
@import "../styles/fonts.css";
```

Preload only the two faces that are above the fold, in `src/app/layout.tsx`:

```tsx
<link rel="preload" as="font" type="font/woff2"
      href="/fonts/InstrumentSans[wdth,wght].woff2" crossOrigin="anonymous" />
<link rel="preload" as="font" type="font/woff2"
      href="/fonts/BricolageGrotesque[opsz,wdth,wght,GRAD].woff2" crossOrigin="anonymous" />
```

No other change is needed: `tokens.css` already names all three families first
in their stacks, and the display type already sets the `opsz`, `wdth` and
`GRAD` axes through `--font-variation-*`.
