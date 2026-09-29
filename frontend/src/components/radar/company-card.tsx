import Link from "next/link";
import type { CompanyWithEvents } from "@/lib/data/types";
import { ConfidenceBadge } from "@/components/company/confidence-badge";
import { SignalBadge } from "@/components/company/signal-badge";
import { categoryLabelClasses } from "@/lib/derive/category-color";
import { recencyLabel } from "@/lib/derive/recency";
import { MomentumMeta } from "@/components/company/momentum-meta";

/** The primary event to show inline on the feed — the most recent one. */
function primaryEvent(company: CompanyWithEvents) {
  return company.events[0] ?? null;
}

export function CompanyCard({ company }: { company: CompanyWithEvents }) {
  const event = primaryEvent(company);
  return (
    <Link
      href={`/companies/${company.id}`}
      className="group block rounded-lg border border-line bg-surface px-5 py-4 transition-colors hover:border-accent/40"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2.5">
            <h3 className="truncate font-serif text-lg text-ink group-hover:text-accent">{company.name}</h3>
            <span className="shrink-0 text-xs text-ink-faint">{company.domain}</span>
          </div>
          {company.description ? <p className="mt-1 line-clamp-2 max-w-2xl text-sm text-ink-muted">{company.description}</p> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ConfidenceBadge confidence={company.confidence} />
          <span className="text-xs text-ink-faint">{recencyLabel(company.discoveredAt)}</span>
        </div>
      </div>

      {company.discoveryReason ? (
        <p className="mt-3 border-l-2 border-accent/40 pl-3 text-sm text-ink-muted">
          <span className="font-medium text-ink">Why it&rsquo;s on the radar — </span>
          {company.discoveryReason}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {company.category ? <span className={categoryLabelClasses()}>{company.category}</span> : null}
        {event ? <SignalBadge eventType={event.eventType} short /> : null}
        {company.discoverySource ? <span className="text-xs text-ink-faint">via {company.discoverySource}</span> : null}
      </div>

      <div className="mt-2.5 border-t border-line/60 pt-2.5">
        <MomentumMeta company={company} />
      </div>
    </Link>
  );
}
