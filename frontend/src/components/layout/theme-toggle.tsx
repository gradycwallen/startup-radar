"use client";

import { useEffect, useRef } from "react";
import { THEME_STORAGE_KEY } from "@/lib/theme/constants";

/**
 * Light/dark toggle. Deliberately does NOT hold theme in React state: the current theme lives on
 * `<html data-theme>` (set before paint by the blocking script in src/lib/theme/theme-script.ts),
 * and the sun/moon icons are shown/hidden purely by CSS (`dark:hidden` / `dark:block`) keyed off
 * that attribute. That sidesteps any server/client hydration mismatch entirely — there is nothing
 * about this component's initial render that depends on which theme is active.
 */
export function ThemeToggle() {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => buttonRef.current?.setAttribute("aria-pressed", String(root.getAttribute("data-theme") === "dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  function toggle() {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private-browsing / storage-disabled contexts: the theme still applies for this session.
    }
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={toggle}
      aria-label="Toggle color theme"
      aria-pressed="false"
      className="text-xs font-medium text-ink-muted transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
    >
      <span className="dark:hidden">Dark appearance</span>
      <span className="hidden dark:inline">Light appearance</span>
    </button>
  );
}
