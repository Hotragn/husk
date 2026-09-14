/**
 * Theme.
 *
 * Dark is the product's primary theme and lives on `:root` in `tokens.css`;
 * light is a separately-tuned port under `[data-theme="light"]`. The only job
 * here is to persist an explicit choice and let the OS decide until one is
 * made — `tokens.css` already handles the `:root:not([data-theme])` case.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'husk.console.theme';

function stored(): Theme | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  // Dark by default, not "dark if the OS says so". BRAND.md is explicit that
  // dark is the primary theme and light is the port, and a terminal product
  // that opens white on a machine configured light is not what anyone wanted.
  // An explicit choice always wins and is remembered.
  const [theme, setTheme] = useState<Theme>(() => stored() ?? 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(KEY, next);
      } catch {
        /* persistence is a nicety; the toggle still works for this session */
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
