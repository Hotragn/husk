'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { CheckIcon, CopyIcon } from './Icons';

/**
 * The frame around a highlighted code block, with a copy button.
 *
 * rehype-pretty-code turns every fenced block into
 * `figure > (figcaption?) + pre`, so this replaces the figure rather than the
 * `pre`: the title and the code have to share one bordered box.
 *
 * The text to copy arrives on `data-raw`, attached by a rehype plugin that
 * reads the highlighted lines back out. Reading `textContent` in the browser
 * instead would work today and break the moment line numbers or a diff marker
 * are turned on -- pasting `1 husk doctor` into a terminal is worse than no
 * copy button at all.
 */
export function CodeFigure({
  children,
  'data-raw': raw,
  ...rest
}: ComponentPropsWithoutRef<'figure'> & { 'data-raw'?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // A refused clipboard permission is the browser's decision, not a state
      // this page can fix. The text stays selectable either way.
    }
  }, [raw]);

  return (
    <figure {...rest} className="code-figure">
      {raw ? (
        <button
          type="button"
          className="code-copy"
          onClick={copy}
          data-copied={copied}
          aria-label={copied ? 'Copied to clipboard' : 'Copy code to clipboard'}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span aria-hidden="true">{copied ? 'copied' : 'copy'}</span>
        </button>
      ) : null}
      {children}
    </figure>
  );
}
