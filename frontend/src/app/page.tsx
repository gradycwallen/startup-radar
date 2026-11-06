import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { getSignalTotals } from "@/lib/data/totals";
import { CompanyCard } from "@/components/radar/company-card";
import { CompanyFilterBar } from "@/components/controls/company-filter-bar";
import { DataSourceBanner } from "@/components/ui/data-source-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { distinctCategories, distinctEventTypes, filterCompanies, parseFilters } from "@/lib/filters";
import { daysSince } from "@/lib/derive/recency";

export default async function RadarPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const [{ source, companies }, totals] = await Promise.all([getAllCompaniesWithEvents(), getSignalTotals()]);
  const filtered = filterCompanies(companies, filters);
  const categories = distinctCategories(companies);
  const stats = [
    ["Companies tracked", companies.length],
    ["New this week", companies.filter((c) => daysSince(c.discoveredAt) <= 7).length],
    ["Categories", categories.length],
    ["Total signals", source === "supabase" ? totals.signals : null],
    ["Total observations", source === "supabase" ? totals.observations : null],
  ] as const;

  return (
    <main className="mx-auto max-w-7xl px-6 pb-16 pt-14 sm:px-8 sm:pt-20">
      <div className="grid gap-7 border-b border-line-strong pb-10 md:grid-cols-[1.5fr_1fr] md:items-end md:gap-16 md:pb-14">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">The startup directory</p>
          <h1 className="mt-5 max-w-3xl text-6xl font-bold leading-[0.94] tracking-[-0.065em] sm:text-7xl lg:text-[6.5rem]">Discover<br />what&rsquo;s next.</h1>
        </div>
        <p className="max-w-md text-lg leading-relaxed text-ink-muted md:border-l md:border-line-strong md:pl-8 md:text-xl">A directory of emerging startups, the signals they leave behind, and the evidence worth following.</p>
      </div>

      <dl className="grid grid-cols-2 border-b border-line sm:grid-cols-3 lg:grid-cols-5">
        {stats.map(([label, value]) => <div key={label} className="py-5 pr-3 sm:py-6"><dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{label}</dt><dd className="tabular mt-2 text-2xl font-semibold tracking-tight">{value === null ? "—" : value.toLocaleString("en-US")}</dd></div>)}
      </dl>
      <DataSourceBanner source={source} />
      <section aria-label="Company directory" className="mt-10">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">The radar</p><h2 className="mt-2 text-3xl font-bold tracking-tight">Companies to watch</h2></div><p className="font-mono text-xs uppercase tracking-wider text-ink-faint">{filtered.length} {filtered.length === 1 ? "company" : "companies"}</p></div>
        <CompanyFilterBar initial={filters} categories={categories} eventTypes={distinctEventTypes(companies)} variant="full" searchPlaceholder="Search companies, domains or categories…" />
        <div aria-hidden="true" className="mt-8 hidden grid-cols-[3rem_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,2fr)_7rem] gap-4 border-b border-line-strong pb-3 text-[10px] font-semibold uppercase tracking-[0.15em] text-ink-faint sm:grid"><span>#</span><span>Company</span><span>Category</span><span>Evidence</span><span className="text-right">Added</span></div>
        {filtered.length === 0 ? <EmptyState title="No companies match these filters" description="Try widening the discovery window or clearing a filter." /> : <div>{filtered.map((company, index) => <CompanyCard key={company.id} company={company} index={index} />)}</div>}
      </section>
    </main>
  );
}
