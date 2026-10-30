import Link from 'next/link';
import { nav } from '@/lib/content';
import { REPO_URL, WEB_URL } from '@/lib/site';
import { HuskLockup } from './Icons';
import { MobileNav } from './MobileNav';
import { Search } from './Search';
import { ThemeToggle } from './ThemeToggle';

export function Header() {
  const sections = nav();

  return (
    <header className="header">
      <div className="header-inner">
        <MobileNav nav={sections} />

        <Link className="brand" href="/">
          <HuskLockup />
          <span className="visually-hidden">Husk</span>
          <span className="brand-suffix" aria-hidden="true">
            docs
          </span>
        </Link>

        <nav className="header-nav" aria-label="Main">
          <Link className="header-link" href="/start">
            Start here
          </Link>
          <Link className="header-link" href="/reference/cli">
            Reference
          </Link>
          <Link className="header-link" href="/security">
            Security
          </Link>
          <Link className="header-link" href="/troubleshooting">
            Troubleshooting
          </Link>
          {/* The way back out. These are two deployments, so it is an anchor
              rather than a Link -- next/link would prefetch a route that does
              not exist in this app. */}
          <a className="header-link header-link-cross" href={WEB_URL}>
            Husk home
          </a>
        </nav>

        <div className="header-spacer" />

        <div className="header-actions">
          <Search />
          <a
            className="header-link"
            href={REPO_URL}
            rel="noreferrer noopener"
            target="_blank"
          >
            GitHub
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
