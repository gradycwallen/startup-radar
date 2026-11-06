import Link from "next/link";
import type { CompanyWithEvents } from "@/lib/data/types";
import { recencyLabel } from "@/lib/derive/recency";
import { CompanyLogo } from "@/components/ui/company-logo";

export function CompanyCard({ company, index }: { company: CompanyWithEvents; index: number }) {
  const evidence = company.events[0]?.headline ?? company.discoveryReason ?? company.description;
  return (
    <Link href={`/companies/${company.id}`} className="group grid gap-3 border-b border-line py-5 transition-colors hover:bg-accent-soft/40 sm:grid-cols-[3rem_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,2fr)_7rem] sm:items-center sm:gap-4">
      <span className="hidden w-fit bg-accent px-2 py-1 font-mono text-xs text-white sm:block">{String(index + 1).padStart(2, "0")}</span>
      <div className="flex min-w-0 items-center gap-3">
        <CompanyLogo domain={company.domain} name={company.name} size={32} />
        <div className="min-w-0"><h3 className="truncate text-lg font-bold tracking-tight group-hover:text-accent">{company.name}</h3><p className="truncate text-xs text-ink-faint">{company.domain}</p></div>
      </div>
      <span className="text-sm text-ink-muted">{company.category ?? "Uncategorized"}</span>
      <p className="line-clamp-2 text-sm leading-relaxed text-ink-muted">{evidence ?? "Evidence available on company profile."}</p>
      <span className="font-mono text-xs text-ink-faint sm:text-right">{recencyLabel(company.discoveredAt)}</span>
    </Link>
  );
}
