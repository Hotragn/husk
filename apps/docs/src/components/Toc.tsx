'use client';

import { useEffect, useState } from 'react';
import type { TocEntry } from '@/lib/content';

/**
 * On-page contents, with the current heading marked.
 *
 * The "current" heading is the last one whose top has passed the header. An
 * IntersectionObserver alone gets this wrong for a short section at the bottom
 * of a long page, which never becomes the topmost intersecting element, so
 * this reads positions on scroll instead and throttles with
 * `requestAnimationFrame`.
 */
export function Toc({ entries }: { entries: TocEntry[] }) {
  const [active, setActive] = useState<string | undefined>(entries[0]?.id);

  useEffect(() => {
    if (entries.length === 0) return;
    let frame = 0;

    const update = () => {
      frame = 0;
      // The sticky header is 64px; a heading is "reached" a little before it
      // touches the header, or the highlight lags a scroll behind the reader.
      const line = 96;
      let current = entries[0]?.id;
      for (const entry of entries) {
        const element = document.getElementById(entry.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= line) current = entry.id;
        else break;
      }
      setActive(current);
    };

    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <nav aria-labelledby="toc-heading">
      <h2 className="toc-heading" id="toc-heading">
        On this page
      </h2>
      <ul className="toc-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a
              className="toc-link"
              href={`#${entry.id}`}
              data-depth={entry.depth}
              data-active={entry.id === active}
              aria-current={entry.id === active ? 'location' : undefined}
            >
              {entry.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
