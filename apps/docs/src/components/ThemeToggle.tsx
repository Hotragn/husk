'use client';

import { useCallback, useEffect, useState } from 'react';
import { THEME_KEY } from '@/lib/theme';
import { MoonIcon, SunIcon } from './Icons';

/**
 * Dark is the primary theme; light is the port, not the other way around
 * (UI-PRINCIPLES section 8.12). So there are three states, not two: no stored
 * choice at all, in which case tokens.css follows `prefers-color-scheme`, and
 * the two explicit choices, which set `data-theme` on `<html>` and win.
 *
 * The state is read once on mount rather than during render, because the
 * server has no way to know it and a mismatch would be a hydration error. The
 * inline script in `ThemeScript` is what stops the page flashing in the
 * meantime.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light' | undefined>(undefined);

  useEffect(() => {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') setTheme(attr);
  }, []);

  const toggle = useCallback(() => {
    const current =
      theme ??
      (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private browsing with storage denied. The toggle still works for this
      // page load; it just will not be remembered, and saying so in a toast
      // would be noise.
    }
  }, [theme]);

  return (
    <button type="button" className="icon-button" onClick={toggle} aria-label="Switch theme">
      <SunIcon />
      <MoonIcon />
    </button>
  );
}
