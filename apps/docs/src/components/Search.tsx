'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SearchIcon } from './Icons';

/** One entry in the static index built by app/search-index.json/route.ts. */
export interface SearchDoc {
  href: string;
  title: string;
  section: string;
  description: string;
  headings: string[];
  text: string;
}

interface Hit {
  doc: SearchDoc;
  score: number;
  snippet: string;
}

const MAX_HITS = 8;

/**
 * Client-side search over a static index.
 *
 * The index is a JSON file generated at build time and fetched on first open,
 * not on first paint: a reader who never searches never pays for it. There is
 * no Algolia and no third-party request -- the same reason the fonts are
 * self-hosted.
 *
 * Scoring is deliberately simple. Thirty pages of documentation do not need
 * BM25; they need every term to appear somewhere, and titles to beat prose.
 */
export function Search() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [docs, setDocs] = useState<SearchDoc[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState(0);

  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  // Cmd-K / Ctrl-K, and "/" when the reader is not already typing somewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement;
      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((v) => !v);
      } else if (event.key === '/' && !typing && !open) {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open || docs || failed) return;
    let cancelled = false;
    fetch('/search-index.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: SearchDoc[]) => {
        if (!cancelled) setDocs(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, docs, failed]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const hits = useMemo(() => (docs ? rank(docs, query) : []), [docs, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery('');
      router.push(href);
    },
    [router],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => (hits.length === 0 ? 0 : (c + 1) % hits.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => (hits.length === 0 ? 0 : (c - 1 + hits.length) % hits.length));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setCursor(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setCursor(Math.max(0, hits.length - 1));
    } else if (event.key === 'Enter') {
      const hit = hits[cursor];
      if (hit) {
        event.preventDefault();
        go(hit.doc.href);
      }
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="search-trigger"
        onClick={() => setOpen(true)}
        aria-label="Search the documentation"
      >
        <SearchIcon />
        <span className="search-trigger-label" aria-hidden="true">
          Search
        </span>
        <kbd className="kbd" aria-hidden="true">
          Ctrl K
        </kbd>
      </button>

      {open ? (
        <>
          <div className="scrim" onClick={close} aria-hidden="true" />
          <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search">
            <div className="search-panel" onKeyDown={onKeyDown}>
              <div className="search-field">
                <SearchIcon />
                <input
                  ref={input}
                  className="search-input"
                  type="search"
                  placeholder="Search the documentation"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  role="combobox"
                  aria-expanded={hits.length > 0}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {failed ? (
                <p className="search-status">
                  The search index did not load. Reload the page, or use your browser&rsquo;s own
                  find-in-page on the section you are reading.
                </p>
              ) : !docs ? (
                <p className="search-status" aria-busy="true">
                  Loading the index.
                </p>
              ) : query.trim() === '' ? (
                <p className="search-status">
                  Type to search. <code>Enter</code> opens, arrow keys move, <code>Esc</code>{' '}
                  closes.
                </p>
              ) : hits.length === 0 ? (
                <p className="search-status">
                  Nothing matches &ldquo;{query}&rdquo;. Every word has to appear on the page, so
                  try one fewer.
                </p>
              ) : (
                <ul className="search-results" id={listId} role="listbox">
                  {hits.map((hit, i) => (
                    <li key={hit.doc.href} role="option" aria-selected={i === cursor}>
                      <a
                        className="search-result"
                        href={hit.doc.href}
                        data-active={i === cursor}
                        onMouseEnter={() => setCursor(i)}
                        onClick={(e) => {
                          e.preventDefault();
                          go(hit.doc.href);
                        }}
                      >
                        <span className="search-result-title">
                          {hit.doc.title}{' '}
                          <span className="search-result-section">— {hit.doc.section}</span>
                        </span>
                        <span className="search-result-snippet">{hit.snippet}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}

              <p className="search-foot">
                {docs ? `${docs.length} pages indexed at build time. Nothing is sent anywhere.` : ''}
              </p>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

/** Every term must appear somewhere on the page; where it appears sets the score. */
function rank(docs: SearchDoc[], query: string): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const hits: Hit[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const section = doc.section.toLowerCase();
    const description = doc.description.toLowerCase();
    const headings = doc.headings.join('   ').toLowerCase();
    const text = doc.text.toLowerCase();

    let score = 0;
    let matchedAll = true;

    for (const term of terms) {
      let termScore = 0;
      if (title.startsWith(term)) termScore += 24;
      else if (title.includes(term)) termScore += 16;
      if (section.includes(term)) termScore += 6;
      if (description.includes(term)) termScore += 6;
      if (headings.includes(term)) termScore += 8;
      if (text.includes(term)) termScore += 2;
      if (termScore === 0) {
        matchedAll = false;
        break;
      }
      score += termScore;
    }

    if (!matchedAll) continue;
    hits.push({ doc, score, snippet: snippetFor(doc, terms[0] as string) });
  }

  return hits.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title)).slice(0, MAX_HITS);
}

/** A window of the page text around the first term, so a hit shows its context. */
function snippetFor(doc: SearchDoc, term: string): string {
  const at = doc.text.toLowerCase().indexOf(term);
  if (at === -1) return doc.description;
  const start = Math.max(0, at - 60);
  const end = Math.min(doc.text.length, at + 120);
  return `${start > 0 ? '…' : ''}${doc.text.slice(start, end).trim()}${end < doc.text.length ? '…' : ''}`;
}
