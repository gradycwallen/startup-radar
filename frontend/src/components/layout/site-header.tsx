import Link from "next/link";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-serif text-xl font-medium tracking-tight text-ink">Startup Radar</span>
          <span className="hidden font-sans text-[11px] font-medium uppercase tracking-[0.14em] text-ink-faint sm:inline">
            Discovery intelligence
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <NavLinks />
          <span aria-hidden className="mx-1 h-5 w-px bg-line" />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
