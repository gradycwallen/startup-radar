import Link from "next/link";
import type { CompanyWithEvents } from "@/lib/data/types";
import { ConfidenceBadge } from "@/components/company/confidence-badge";
import { SignalBadge } from "@/components/company/signal-badge";
import { categoryLabelClasses } from "@/lib/derive/category-color";
import { recencyLabel } from "@/lib/derive/recency";
import { MomentumMeta } from "@/components/company/momentum-meta";
import { CompanyLogo } from "@/components/ui/company-logo";

/** The primary event to show inline on the feed — the most recent one. */
function primaryEvent(company: CompanyWithEvents) {
  return company.events[0] ?? null;
}

// Borderless list row, not a bordered/rounded card — each entry is separated from the next by the
// parent's `divide-y` hairline (see app/page.tsx), and the hover fill bleeds to the page's own
// side padding via the negative-margin trick below, rather than stopping at a boxed edge.
export function CompanyCard({ company }: { company: CompanyWithEvents }) {
  const event = primaryEvent(company);
  return (
    <Link
      href={`/companies/${company.id}`}
      className="group -mx-6 block px-6 py-6 transition-colors hover:bg-line/25 sm:-mx-8 sm:px-8"
    >
      {/* No flex-wrap here on purpose: with wrap allowed, a long name/description could push the
          confidence badge onto its own line, where it lands left-aligned instead of pinned top-
          right (a real layout bug found in review). `flex-1 min-w-0` on the left column lets it
          shrink/truncate instead, so the right column never has anywhere else to go. */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 gap-3.5">
          <CompanyLogo domain={company.domain} name={company.name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <h3 className="truncate font-serif text-xl text-ink group-hover:text-accent">{company.name}</h3>
              <span className="shrink-0 text-xs text-ink-faint">{company.domain}</span>
            </div>
            {company.description ? <p className="mt-1 line-clamp-2 max-w-4xl text-sm text-ink-muted">{company.description}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ConfidenceBadge confidence={company.confidence} />
          <span className="text-xs text-ink-faint">{recencyLabel(company.discoveredAt)}</span>
        </div>
      </div>

      {company.discoveryReason ? (
        <p className="mt-4 max-w-4xl border-l-2 border-accent/45 pl-4 text-[15px] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">Why it&rsquo;s on the radar — </span>
          {company.discoveryReason}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {company.category ? <span className={categoryLabelClasses()}>{company.category}</span> : null}
        {event ? <SignalBadge eventType={event.eventType} short /> : null}
        {company.discoverySource ? <span className="text-xs text-ink-faint">via {company.discoverySource}</span> : null}
      </div>

      <div className="mt-3">
        <MomentumMeta company={company} />
      </div>
    </Link>
  );
}
