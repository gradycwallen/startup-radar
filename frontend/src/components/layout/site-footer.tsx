import Link from "next/link";

const LINKS = [
  { href: "/", label: "Radar" },
  { href: "/explore", label: "Explore" },
  { href: "/methodology", label: "Methodology" },
] as const;

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-serif text-lg text-ink">Startup Radar</p>
          <p className="mt-1.5 max-w-xs text-sm text-ink-muted">Discovery intelligence for emerging startups — before they&rsquo;re obvious.</p>
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
        <div className="mx-auto max-w-6xl px-6 py-4 text-xs text-ink-faint">
          © {year} Startup Radar. Evidence-based discovery, not investment advice.
        </div>
      </div>
    </footer>
  );
}
