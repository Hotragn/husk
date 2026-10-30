import localFont from "next/font/local";

/**
 * Newsreader, and only here.
 *
 * The manifesto is the one page on this site that is an essay rather than a
 * product surface -- different voice, different rhythm, read start to finish
 * rather than scanned. A serif for its body copy says that in the first line,
 * before the argument has to. Headings stay in General Sans so the page still
 * belongs to the site.
 *
 * Declared in this route's own module, not the root layout, so next/font
 * preloads it on `/manifesto` and nowhere else. The face is instanced to
 * `opsz 18` -- the optical size for body text -- which drops the axis and most
 * of the file with it, from 129K to 53K.
 */
export const newsreader = localFont({
  src: [
    { path: "../../fonts/Newsreader-Variable.woff2", weight: "200 800", style: "normal" },
    { path: "../../fonts/Newsreader-VariableItalic.woff2", weight: "200 800", style: "italic" },
  ],
  variable: "--font-newsreader",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["Iowan Old Style", "Charter", "Georgia", "Times New Roman", "serif"],
});
