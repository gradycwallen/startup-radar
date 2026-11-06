import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { getSignalTotals } from "@/lib/data/totals";
import { CompanyCard } from "@/components/radar/company-card";
import { CompanyFilterBar } from "@/components/controls/company-filter-bar";
import { DataSourceBanner } from "@/components/ui/data-source-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { distinctCategories, distinctEventTypes, filterCompanies, parseFilters } from "@/lib/filters";
import { daysSince } from "@/lib/derive/recency";
import Link from "next/link";
import { StartExploring } from "@/components/radar/start-exploring";

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
        {stats.map(([label, value]) => <div key={label} className="border-l border-line py-5 pl-4 pr-2 first:border-l-0 first:pl-0 sm:py-7 lg:pl-6"><dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{label}</dt><dd className="tabular mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{value === null ? "N/A" : label === "Total observations" && value >= 1000 ? <span title={value.toLocaleString("en-US")} aria-label={`${value.toLocaleString("en-US")} observations`}>{Math.floor(value / 1000)}K+</span> : value.toLocaleString("en-US")}</dd></div>)}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-ink-muted"><strong className="text-ink">Observations</strong> are recorded measurements; <strong className="text-ink">signals</strong> are rule-derived findings from those observations. <Link href="/methodology" className="text-accent hover:underline">Learn more</Link></p>
      <DataSourceBanner source={source} />
      <details className="mt-8 border border-line px-5 py-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink">How to read Startup Radar</summary>
        <ol className="mt-4 grid gap-4 text-sm leading-relaxed text-ink-muted sm:grid-cols-3">
          <li><strong className="text-ink">01 · Discover.</strong> Browse companies surfaced from public sources.</li>
          <li><strong className="text-ink">02 · Observe.</strong> Scout revisits available GitHub, hiring and website sources.</li>
          <li><strong className="text-ink">03 · Investigate.</strong> Open a profile to inspect signals and follow the original evidence.</li>
        </ol>
        <Link href="/about" className="mt-4 inline-block text-sm font-medium text-accent hover:underline">About the project →</Link>
      </details>
      {source === "supabase" && <StartExploring companies={companies} />}
      <section aria-label="Company directory" className="mt-10">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">The radar</p><h2 className="mt-2 text-3xl font-bold tracking-tight">Companies to watch</h2></div><div className="flex flex-wrap gap-4 text-xs"><a href="/api/companies" className="font-medium text-accent hover:underline">Export JSON</a><a href="/api/companies?format=csv" className="font-medium text-accent hover:underline">Export CSV</a><p className="font-mono uppercase tracking-wider text-ink-faint">{filtered.length} {filtered.length === 1 ? "company" : "companies"}</p></div></div>
        <CompanyFilterBar initial={filters} categories={categories} eventTypes={distinctEventTypes(companies)} variant="full" searchPlaceholder="Search companies, domains or categories…" />
        <div aria-hidden="true" className="mt-8 hidden grid-cols-[3rem_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,2fr)_7rem] gap-4 border-b border-line-strong px-3 pb-3 text-[10px] font-semibold uppercase tracking-[0.15em] text-ink-faint sm:grid"><span>#</span><span>Company</span><span>Category</span><span>Evidence</span><span className="pr-6 text-right">Added</span></div>
        {filtered.length === 0 ? <EmptyState title="No companies match these filters" description="Try widening the discovery window or clearing a filter." /> : <div>{filtered.map((company, index) => <CompanyCard key={company.id} company={company} index={index} />)}</div>}
      </section>
    </main>
  );
}
