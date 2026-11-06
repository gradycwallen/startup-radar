import Link from "next/link";
import type { CompanyWithEvents } from "@/lib/data/types";
import { recencyLabel } from "@/lib/derive/recency";
import { CompanyLogo } from "@/components/ui/company-logo";
import { eventTypeMeta } from "@/lib/derive/event-type";

export function CompanyCard({ company, index }: { company: CompanyWithEvents; index: number }) {
  const evidence = company.events[0]?.headline ?? company.discoveryReason ?? company.description;
  return (
    <Link href={`/companies/${company.id}`} className="group grid gap-3 border-b border-line px-2 py-6 transition-colors duration-200 hover:bg-accent-soft/60 focus-visible:bg-accent-soft/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent sm:grid-cols-[3rem_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,2fr)_7rem] sm:items-center sm:gap-4 sm:px-3 sm:py-7">
      <span className="hidden w-fit border border-line-strong px-2 py-1 font-mono text-xs text-ink-muted transition-colors group-hover:border-accent group-hover:text-accent sm:block">{String(index + 1).padStart(2, "0")}</span>
      <div className="flex min-w-0 items-center gap-3">
        <CompanyLogo domain={company.domain} name={company.name} size={32} />
        <div className="min-w-0"><h3 className="truncate text-lg font-bold tracking-tight group-hover:text-accent">{company.name}</h3><p className="truncate text-xs text-ink-faint">{company.domain}</p></div>
      </div>
      <span className="text-sm text-ink-muted">{company.category ?? "Uncategorized"}</span>
      <div><p className="line-clamp-2 text-sm leading-relaxed text-ink-muted">{evidence ?? "Evidence available on company profile."}</p>{company.events[0] && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-faint"><span className="border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">{eventTypeMeta(company.events[0].eventType).short}</span>{company.events[0].sourceName && <span>{company.events[0].sourceName}</span>}</div>}</div>
      <span className="flex items-center gap-2 font-mono text-xs text-ink-faint sm:justify-end"><span>{recencyLabel(company.discoveredAt)}</span><span aria-hidden="true" className="text-base text-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">↗</span></span>
    </Link>
  );
}
