import Link from "next/link";
import type { CompanyWithEvents } from "@/lib/data/types";
import { ConfidenceBadge } from "@/components/company/confidence-badge";
import { categoryClasses } from "@/lib/derive/category-color";
import { recencyLabel } from "@/lib/derive/recency";
import { MomentumMeta } from "@/components/company/momentum-meta";

export function ExploreCard({ company }: { company: CompanyWithEvents }) {
  return (
    <Link
      href={`/companies/${company.id}`}
      className="group flex h-full flex-col rounded-lg border border-line bg-surface p-4 transition-all hover:border-line-strong hover:shadow-[0_8px_24px_-16px_rgba(0,0,0,0.25)] dark:hover:shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)]"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-serif text-base text-ink group-hover:text-accent">{company.name}</h3>
        <span className="shrink-0 text-[11px] text-ink-faint">{recencyLabel(company.discoveredAt)}</span>
      </div>
      <p className="text-xs text-ink-faint">{company.domain}</p>
      {company.description ? <p className="mt-2 line-clamp-3 flex-1 text-sm text-ink-muted">{company.description}</p> : <div className="flex-1" />}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {company.category ? <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${categoryClasses(company.category)}`}>{company.category}</span> : null}
        <ConfidenceBadge confidence={company.confidence} />
      </div>

      <div className="mt-2.5 border-t border-line/60 pt-2.5">
        <MomentumMeta company={company} />
      </div>
    </Link>
  );
}
