import { Analytics } from '@vercel/analytics/next';
import type { Metadata, Viewport } from 'next';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { ThemeScript } from '@/components/ThemeScript';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';
import { SITE_URL } from '@/lib/site-url';
import { commitMono, generalSans } from './fonts';
import './globals.css';

/**
 * Vercel Web Analytics is served from `/_vercel/insights/` on this origin, not
 * a third-party host, so the property `public/fonts/README.md` argues for --
 * no request leaving for anyone the reader did not choose to talk to -- still
 * holds.
 *
 * Worth being precise, because this site says "no telemetry": that claim is
 * about the product. `husk` the CLI phones nobody and nothing here changes it.
 * This counts page views of a marketing site, which is a different thing from
 * a tool reporting on its user -- but it is still measurement, and saying so
 * is cheaper than being caught omitting it.
 */

/**
 * `metadataBase` was here before the Open Graph tags were, which is why the
 * audit found neither a canonical nor an `og:` tag on any page sampled: a base
 * URL is what `alternates` and `openGraph` are resolved *against*, not a
 * substitute for declaring them.
 *
 * These are the defaults. Both routes that render anything -- the landing page
 * and `[...slug]` -- override `title`, `description`, `canonical` and the
 * `openGraph` pair with the page's own frontmatter, which is already written
 * per page and needs no second copy.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s — ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  icons: { icon: '/favicon.svg' },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    url: '/',
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  // Dark first, because dark is the primary theme and light is the port.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0f0b07' },
    { media: '(prefers-color-scheme: light)', color: '#f6f3ed' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${generalSans.variable} ${commitMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body>
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <Header />
        {children}
        <Footer />
        <Analytics />
      </body>
    </html>
  );
}
