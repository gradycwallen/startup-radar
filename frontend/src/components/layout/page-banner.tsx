import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui/eyebrow";

/** Shared page header — eyebrow, serif title, optional description — used by every top-level page
 * (Radar, Explore, Methodology) so they open the same way. Plain content, no banner graphic: the
 * typography itself is the identity here, not a background effect. */
export function PageBanner({ eyebrow, title, children, compact = false }: { eyebrow: string; title: string; children?: ReactNode; compact?: boolean }) {
  if (compact) {
    return (
      <div className="mx-auto max-w-7xl px-6 pt-10 sm:px-8 sm:pt-12">
        <div className="border-b border-line-strong pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">{eyebrow}</p>
          <h1 className="mt-2 text-xl font-semibold leading-snug tracking-tight text-ink sm:text-2xl">{title}</h1>
          {children ? <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-muted">{children}</p> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="stagger mx-auto max-w-7xl px-6 pt-10 sm:px-8 sm:pt-16">
      <div className="max-w-2xl">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-3 text-4xl font-bold leading-[1.05] tracking-tight text-ink sm:text-6xl">{title}</h1>
        {children ? <p className="mt-5 text-base leading-relaxed text-ink-muted sm:text-lg">{children}</p> : null}
      </div>
    </div>
  );
}
