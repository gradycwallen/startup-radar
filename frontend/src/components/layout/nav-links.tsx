"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const LINKS = [
  { href: "/", label: "Radar" },
  { href: "/explore", label: "Explore" },
  { href: "/insights", label: "Insights" },
  { href: "/about", label: "About" },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main navigation" className="flex items-center gap-3 sm:gap-5">
      {LINKS.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={clsx(
              "relative py-1.5 text-sm font-medium transition-colors duration-200",
              "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:origin-left after:rounded-full after:transition-transform after:duration-300 after:ease-[var(--ease-out)]",
              active ? "text-ink after:scale-x-100 after:bg-accent" : "text-ink-muted after:scale-x-0 after:bg-ink-faint hover:text-ink hover:after:scale-x-100",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
