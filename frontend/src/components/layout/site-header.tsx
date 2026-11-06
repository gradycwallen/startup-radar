import Link from "next/link";
import Image from "next/image";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  return (
    // A solid canvas ground (no backdrop-blur) and a hairline rule — closer to a masthead than a
    // floating glass app-bar.
    <header className="sticky top-0 z-30 border-b border-line bg-canvas">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:h-20 sm:px-8">
        <Link href="/" className="flex items-center gap-2 leading-none" aria-label="Startup Radar home">
          <Image src="/startup-radar-mark.png" alt="" width={42} height={42} className="h-9 w-9 mix-blend-multiply dark:invert dark:mix-blend-screen sm:h-11 sm:w-11" />
          <span className="text-lg font-bold tracking-tight text-ink sm:text-2xl">Startup Radar</span>
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
