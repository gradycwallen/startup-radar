import { THEME_STORAGE_KEY } from "./constants";

/**
 * A blocking (`beforeInteractive`) inline script, injected in the root layout, that sets
 * `<html data-theme>` BEFORE first paint — this is what avoids a flash of the wrong theme. It runs
 * outside React entirely: a stored choice (set via ThemeToggle) always wins; otherwise it follows
 * the OS/browser's `prefers-color-scheme` on first visit, like any normal site. Wrapped in
 * try/catch because `localStorage`/`matchMedia` can throw in some private-browsing contexts — a
 * failure here must never block rendering, it just falls back to light.
 */
export function themeInitScript(): string {
  return `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var s=localStorage.getItem(k);var t=(s==="light"||s==="dark")?s:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;
}
