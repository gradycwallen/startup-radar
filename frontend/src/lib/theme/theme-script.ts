import { THEME_STORAGE_KEY } from "./constants";

/**
 * A blocking (`beforeInteractive`) inline script, injected in the root layout, that sets
 * `<html data-theme>` BEFORE first paint — this is what avoids a flash of the wrong theme. It runs
 * outside React entirely: on first visit it defaults to dark — the identity the homepage's terminal
 * hero sets — and once the user has picked a theme (via ThemeToggle), that stored choice wins. Wrapped in try/catch
 * because `localStorage`/`matchMedia` can throw in some private-browsing contexts — a failure here
 * must never block rendering, it just falls back to dark.
 */
export function themeInitScript(): string {
  return `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var s=localStorage.getItem(k);var t=(s==="light"||s==="dark")?s:"dark";document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;
}
