'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavSection } from '@/lib/content';

/**
 * The section rail.
 *
 * Everything is rendered flat and always visible: there are eight sections and
 * about thirty pages, which fits in one scroll without collapsible groups, and
 * a group a reader has to open before they can see what is inside it is a
 * group that hides the answer.
 */
export function SidebarNav({ nav, onNavigate }: { nav: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation">
      {nav.map((section) => (
        <div className="nav-section" key={section.dir}>
          <h2 className="nav-heading">{section.title}</h2>
          <ul className="nav-list">
            {section.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="nav-link"
                  aria-current={pathname === item.href ? 'page' : undefined}
                  onClick={onNavigate}
                >
                  {item.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
