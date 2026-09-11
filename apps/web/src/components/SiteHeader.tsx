"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { HuskMark, HuskWordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { REPO_URL } from "@/lib/content";

const NAV = [
  { href: "/manifesto", label: "Manifesto" },
  { href: "/pricing", label: "Pricing" },
];

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
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
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
