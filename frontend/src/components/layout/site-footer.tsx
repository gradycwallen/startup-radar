import Link from "next/link";

const LINKS = [
  { href: "/", label: "Radar" },
  { href: "/explore", label: "Explore" },
  { href: "/methodology", label: "Methodology" },
] as const;

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-14 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-serif text-2xl tracking-tight text-ink">Startup Radar</p>
          <p className="mt-2 max-w-xs text-sm text-ink-muted">Discovery intelligence for emerging startups — before they&rsquo;re obvious.</p>
          <p className="mt-4 inline-flex items-center gap-2 font-mono text-xs text-accent">
            <span aria-hidden className="text-ink-faint">&gt;</span>
            scout --watch
            <span aria-hidden className="matrix-caret inline-block h-[1em] w-[0.5em] translate-y-[1px] bg-accent" />
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="font-medium text-ink-muted hover:text-ink">
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="border-t border-line/60">
        <div className="mx-auto max-w-6xl px-6 py-4 font-mono text-[11px] text-ink-faint">
          © {year} Startup Radar. Evidence-based discovery, not investment advice.
        </div>
      </div>
    </footer>
  );
}
