import type { Metadata, Viewport } from "next";

import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { SITE_DESCRIPTION } from "@/lib/content";
import { SITE_URL } from "@/lib/site-url";
import { commitMono, generalSans } from "./fonts";
import "./globals.css";

/**
 * No next/font/google here, and no <link> to a font CDN. The product's claim
 * is that nothing leaves your machine; a third-party font origin on the
 * homepage would contradict it in the first 200ms. The faces are self-hosted
 * from src/fonts through next/font/local — see src/app/fonts.ts.
 */

/**
 * Page views are counted by Cloudflare Web Analytics, which Cloudflare adds to
 * each page as it serves it; there is no analytics code in this repository.
 * The beacon loads from `static.cloudflareinsights.com` -- Cloudflare's own
 * host, the company already serving every byte of this site -- so no third
 * party learns of a visit, and it sets no cookie.
 *
 * Worth being precise, because this site says "no telemetry": that claim is
 * about the product. `husk` the CLI phones nobody and nothing here changes it.
 * This counts page views of a marketing site, which is a different thing from
 * a tool reporting on its user -- but it is still measurement, and saying so
 * is cheaper than being caught omitting it.
 */

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Husk — your AI chat gets a computer",
    template: "%s — Husk",
  },
  description: SITE_DESCRIPTION,
  applicationName: "Husk",
  /* No `keywords`. Google dropped the meta keywords signal in 2009 and every
     other major engine followed; it was seven strings of payload that no
     crawler reads. */
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Husk",
    url: "/",
    title: "Husk — your AI chat gets a computer",
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Husk — your AI chat gets a computer",
    description: SITE_DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0f0b07" },
    { media: "(prefers-color-scheme: light)", color: "#f6f3ed" },
  ],
};

/**
 * Applies a remembered theme before first paint. Without this the page renders
 * dark and then snaps to light, which is a flash of the wrong interface rather
 * than a transition.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem('husk-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${generalSans.variable} ${commitMono.variable}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
