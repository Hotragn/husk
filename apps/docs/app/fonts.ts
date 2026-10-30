import localFont from 'next/font/local';

/**
 * The same two faces as `apps/web`, from byte-identical files, declared the
 * same way. The docs site has no serif: Newsreader exists for one essay on the
 * marketing site and nothing here reads like an essay.
 *
 * See `apps/web/src/app/fonts.ts` for why this is `next/font/local` rather than
 * a hand-written `@font-face`, and for the note about U+26A0.
 */

export const generalSans = localFont({
  src: [
    { path: '../src/fonts/GeneralSans-Variable.woff2', weight: '200 700', style: 'normal' },
    { path: '../src/fonts/GeneralSans-VariableItalic.woff2', weight: '200 700', style: 'italic' },
  ],
  variable: '--font-general-sans',
  display: 'swap',
  adjustFontFallback: 'Arial',
  fallback: ['Archivo', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
});

export const commitMono = localFont({
  src: [{ path: '../src/fonts/CommitMono-Variable.woff2', weight: '200 700', style: 'normal' }],
  variable: '--font-commit-mono',
  display: 'swap',
  adjustFontFallback: false,
  fallback: [
    'ui-monospace',
    'SFMono-Regular',
    'Menlo',
    'Consolas',
    'DejaVu Sans Mono',
    'monospace',
  ],
});
