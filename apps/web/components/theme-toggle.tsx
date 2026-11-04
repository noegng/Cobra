"use client";

/**
 * Light / dark switch. The choice is stored in a cookie read by the root layout (no flash on the next load) and
 * applied immediately via <html data-theme>. Without a choice, the system preference wins.
 */
import { useEffect, useState } from "react";
import { THEME_COOKIE } from "../lib/theme";
type Theme = "light" | "dark";

const LABEL = { light: "Modo oscuro / Modo escuro / Dark mode", dark: "Modo claro / Light mode" } as const;

function effectiveTheme(): Theme {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(effectiveTheme()), []);

  function flip() {
    const next: Theme = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setTheme(next);
  }

  return (
    <button type="button" className="theme-toggle" onClick={flip} aria-label={LABEL[theme ?? "light"]} title={LABEL[theme ?? "light"]}>
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
    </button>
  );
}
