import Link from "next/link";
import type { CompanyWithEvents } from "@/lib/data/types";
import { ConfidenceBadge } from "@/components/company/confidence-badge";
import { categoryLabelClasses } from "@/lib/derive/category-color";
import { recencyLabel } from "@/lib/derive/recency";
import { MomentumMeta } from "@/components/company/momentum-meta";
import { CompanyLogo } from "@/components/ui/company-logo";

// A real bordered card, not pills-inside-a-box: a dense multi-metric grid of these needs a clear
// boundary per item to stay legible (a fully card-less version of this grid read as messy, not
// minimal, in review) — the plain-text category/signal labels are what stay pill-free, not the
// card edge itself.
export function ExploreCard({ company }: { company: CompanyWithEvents }) {
  return (
    <Link
      href={`/companies/${company.id}`}
      className="reveal group flex h-full flex-col border border-line bg-surface p-4 transition-colors duration-200 hover:border-accent/40"
    >
      <div className="flex items-start gap-2.5">
        <CompanyLogo domain={company.domain} name={company.name} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-base font-semibold text-ink transition-colors duration-200 group-hover:text-accent">{company.name}</h3>
            <span className="shrink-0 font-mono text-[11px] text-ink-faint">{recencyLabel(company.discoveredAt)}</span>
          </div>
          <p className="truncate text-xs text-ink-faint">{company.domain}</p>
        </div>
      </div>
      {company.description ? <p className="mt-2 line-clamp-3 flex-1 text-sm text-ink-muted">{company.description}</p> : <div className="flex-1" />}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {company.category ? <span className={categoryLabelClasses()}>{company.category}</span> : null}
        <ConfidenceBadge confidence={company.confidence} />
      </div>

      <div className="mt-2.5 border-t border-line/60 pt-2.5">
        <MomentumMeta company={company} />
      </div>
    </Link>
  );
}
