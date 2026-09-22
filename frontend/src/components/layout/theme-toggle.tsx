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
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-line/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <svg aria-hidden viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px] dark:hidden">
        <circle cx="10" cy="10" r="4" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M10 2.5V4M10 16V17.5M17.5 10H16M4 10H2.5M15.3 4.7L14.2 5.8M5.8 14.2L4.7 15.3M15.3 15.3L14.2 14.2M5.8 5.8L4.7 4.7"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <svg aria-hidden viewBox="0 0 20 20" fill="none" className="hidden h-[18px] w-[18px] dark:block">
        <path
          d="M17 11.3A7 7 0 018.7 3a7 7 0 108.3 8.3z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
