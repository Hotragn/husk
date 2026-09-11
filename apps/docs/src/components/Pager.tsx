import Link from 'next/link';
import type { Neighbours } from '@/lib/content';

/** Previous and next in reading order. Both slots keep their column when empty. */
export function Pager({ previous, next }: Neighbours) {
  if (!previous && !next) return null;

  return (
    <nav className="pager" aria-label="Page">
      {previous ? (
        <Link className="pager-link" href={previous.href} rel="prev">
          <span className="pager-direction">Previous</span>
          <span className="pager-title">{previous.title}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link className="pager-link pager-link-next" href={next.href} rel="next">
          <span className="pager-direction">Next</span>
          <span className="pager-title">{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}
