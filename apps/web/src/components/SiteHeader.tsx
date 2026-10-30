"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { HuskMark, HuskWordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DOCS_URL, REPO_URL } from "@/lib/content";

/**
 * Docs is an external link because the docs are a separate deployment.
 * `DOCS_URL` reads NEXT_PUBLIC_DOCS_URL and falls back to the repository
 * README, so this file needs no edit when the docs move to a real domain.
 */
/* `prefetch: false` on the manifesto for the same reason lib/previews.ts gives:
   Newsreader is 113K, that route is the only one that sets it, and the default
   prefetch was pulling both faces onto every page that renders this header. */
const NAV = [
  { href: "/manifesto", label: "Manifesto", prefetch: false },
  { href: "/pricing", label: "Pricing" },
];

const NAV_EXTERNAL = [{ href: DOCS_URL, label: "Docs" }];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <div className="container site-header-inner">
        <Link href="/" className="lockup" aria-label="Husk, home">
          <HuskMark size={26} />
          <HuskWordmark height={16} />
        </Link>

        <nav className="site-nav" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="nav-link"
              prefetch={item.prefetch}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
          {NAV_EXTERNAL.map((item) => (
            <a
              key={item.label}
              className="nav-link"
              href={item.href}
              rel="noreferrer noopener"
            >
              {item.label}
            </a>
          ))}
          <a
            className="nav-link nav-hide-sm"
            href={REPO_URL}
            rel="noreferrer noopener"
          >
            Source
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
