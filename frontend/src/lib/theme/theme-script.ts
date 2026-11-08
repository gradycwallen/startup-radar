import { THEME_STORAGE_KEY } from "./constants";

/**
 * A blocking (`beforeInteractive`) inline script, injected in the root layout, that sets
 * `<html data-theme>` BEFORE first paint — this is what avoids a flash of the wrong theme. It runs
 * outside React entirely: a stored choice (set via ThemeToggle) wins; otherwise it defaults to
 * light. Wrapped in
 * try/catch because `localStorage`/`matchMedia` can throw in some private-browsing contexts — a
 * failure here must never block rendering, it just falls back to light.
 */
export function themeInitScript(): string {
  return `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});document.documentElement.setAttribute("data-theme",s==="dark"?"dark":"light");}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;
}
