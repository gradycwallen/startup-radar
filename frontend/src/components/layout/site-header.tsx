import Link from "next/link";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  return (
    // A masthead, not a floating glass app-bar: a solid canvas ground (no backdrop-blur) and a
    // deliberately heavier bottom rule, closer to a printed banner than a generic sticky SaaS nav.
    <header className="sticky top-0 z-30 border-b-2 border-ink bg-canvas">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:h-20 sm:px-6">
        <Link href="/" className="flex flex-col leading-none">
          <span className="font-serif text-xl font-medium tracking-tight text-ink sm:text-2xl">Startup Radar</span>
          <span className="mt-1.5 hidden text-[10px] font-semibold uppercase tracking-[0.2em] text-accent sm:block">Discovery intelligence</span>
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
