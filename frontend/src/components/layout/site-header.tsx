import Link from "next/link";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  return (
    // A solid canvas ground (no backdrop-blur) with a hairline rule — the terminal hero sits right
    // under it on the homepage, so the masthead reads as the window chrome above that screen.
    <header className="sticky top-0 z-30 border-b border-line bg-canvas">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:h-20 sm:px-6">
        <Link href="/" className="flex flex-col leading-none">
          <span className="font-serif text-xl font-medium tracking-tight text-ink sm:text-2xl">Startup Radar</span>
          <span className="mt-1.5 hidden font-mono text-[10px] uppercase tracking-[0.18em] text-accent sm:block">
            <span aria-hidden className="mr-1.5 text-ink-faint">&gt;</span>discovery intelligence
          </span>
        </Link>
        <div className="flex items-center gap-3 sm:gap-6">
          <NavLinks />
          <span aria-hidden className="h-5 w-px bg-line" />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
