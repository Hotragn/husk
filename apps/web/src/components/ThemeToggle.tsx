"use client";

import { useCallback, useEffect, useState } from "react";

export const THEME_KEY = "husk-theme";

/**
 * Dark is the primary theme and light is the port, not the other way around
 * (UI-PRINCIPLES.md §8.12). Until the reader chooses, the operating system
 * decides; once they choose, the choice wins and is remembered.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light" | null>(null);

  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") {
      setTheme(attr);
      return;
    }
    setTheme(
      window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark",
    );
  }, []);

  const toggle = useCallback(() => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // A browser with storage denied still gets the theme for this page.
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="btn btn-ghost nav-theme"
      onClick={toggle}
      aria-label={
        theme === "light" ? "Switch to the dark theme" : "Switch to the light theme"
      }
    >
      <span aria-hidden="true">{theme === "light" ? "dark" : "light"}</span>
    </button>
  );
}
