import Link from "next/link";
import type { CompanyWithEvents } from "@/lib/data/types";
import { ConfidenceBadge } from "@/components/company/confidence-badge";
import { SignalBadge } from "@/components/company/signal-badge";
import { categoryClasses } from "@/lib/derive/category-color";
import { recencyLabel } from "@/lib/derive/recency";

/** The primary event to show inline on the feed — the most recent one. */
function primaryEvent(company: CompanyWithEvents) {
  return company.events[0] ?? null;
}

export function CompanyCard({ company }: { company: CompanyWithEvents }) {
  const event = primaryEvent(company);
  return (
    <Link
      href={`/companies/${company.id}`}
      className="group block rounded-lg border border-line bg-surface px-5 py-4 transition-all hover:border-line-strong hover:shadow-[0_1px_0_0_rgba(0,0,0,0.02),0_8px_24px_-16px_rgba(0,0,0,0.25)] dark:hover:shadow-[0_1px_0_0_rgba(0,0,0,0.2),0_8px_24px_-16px_rgba(0,0,0,0.6)]"
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
        {company.category ? <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${categoryClasses(company.category)}`}>{company.category}</span> : null}
        {event ? <SignalBadge eventType={event.eventType} short /> : null}
        {company.discoverySource ? <span className="text-xs text-ink-faint">via {company.discoverySource}</span> : null}
      </div>
    </Link>
  );
}
