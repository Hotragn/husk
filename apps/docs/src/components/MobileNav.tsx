'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { NavSection } from '@/lib/content';
import { WEB_URL } from '@/lib/site';
import { CloseIcon, MenuIcon } from './Icons';
import { SidebarNav } from './SidebarNav';

/**
 * The sidebar, as a drawer, below 1024px.
 *
 * Focus is trapped while it is open, `Escape` closes it, and focus returns to
 * the trigger on close. The drawer slides in over 240ms; under
 * `prefers-reduced-motion` tokens.css collapses that to 1ms and the panel
 * simply appears -- the state change still happens, it just does not travel.
 */
export function MobileNav({ nav }: { nav: NavSection[] }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>('a, button')?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;

      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button drawer-trigger"
        aria-label="Open the documentation menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <MenuIcon />
      </button>

      {open ? (
        <>
          <div className="scrim" onClick={close} aria-hidden="true" />
          <div
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            ref={panel}
          >
            <div className="drawer-head">
              <h2 className="drawer-title" id={titleId}>
                Documentation
              </h2>
              <button
                type="button"
                className="icon-button drawer-close"
                onClick={close}
                aria-label="Close the documentation menu"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="drawer-body">
              <a className="drawer-cross" href={WEB_URL}>
                &larr; Husk home
              </a>
              <SidebarNav nav={nav} onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
