import localFont from "next/font/local";

/**
 * The two faces every page sets.
 *
 * Loaded through `next/font/local` rather than hand-written `@font-face`:
 * next/font emits the declaration, fingerprints the file for immutable
 * caching, preloads it on the routes that use it, and -- the part that
 * actually matters here -- synthesises a metric-matched fallback so the swap
 * from the system face does not reflow the page. There is no third-party
 * origin either way; the files sit in `src/fonts`, and a product whose pitch
 * is that nothing leaves your machine cannot hand a reader's IP address to a
 * font CDN.
 *
 * Both are variable, both subset to latin, both with their real axis ranges
 * declared -- read off the `fvar` table, not guessed. A declared range wider
 * than the font's own makes the browser clamp silently and every weight lands
 * on the wrong step.
 *
 * Commit Mono ships a second `ital` axis that this site never sets, so it is
 * instanced out of the file. Commit Mono has no U+26A0; the one place the docs
 * quote `husk run`'s approval prompt, that single glyph falls back. Quoted
 * output is quoted output -- the alternative was editing a real transcript.
 */

export const generalSans = localFont({
  src: [
    { path: "../fonts/GeneralSans-Variable.woff2", weight: "200 700", style: "normal" },
    { path: "../fonts/GeneralSans-VariableItalic.woff2", weight: "200 700", style: "italic" },
  ],
  variable: "--font-general-sans",
  display: "swap",
  adjustFontFallback: "Arial",
  fallback: ["Archivo", "Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
});

export const commitMono = localFont({
  src: [{ path: "../fonts/CommitMono-Variable.woff2", weight: "200 700", style: "normal" }],
  variable: "--font-commit-mono",
  display: "swap",
  adjustFontFallback: false,
  fallback: [
    "ui-monospace",
    "SFMono-Regular",
    "Menlo",
    "Consolas",
    "DejaVu Sans Mono",
    "monospace",
  ],
});
