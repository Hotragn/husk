import type { Metadata, Viewport } from 'next';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { ThemeScript } from '@/components/ThemeScript';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';
import './globals.css';

export const metadata: Metadata = {
  title: { default: SITE_NAME, template: `%s — ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  icons: { icon: '/favicon.svg' },
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
        {/* The two faces above the fold. The mono face is not preloaded: the
            first code block is below the fold on every page. */}
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/InstrumentSans-latin.woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/BricolageGrotesque-latin.woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <Header />
        {children}
        <Footer />
      </body>
    </html>
  );
}
