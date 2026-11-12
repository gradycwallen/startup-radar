import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { getSignalTotals } from "@/lib/data/totals";
import { CompanyCard } from "@/components/radar/company-card";
import { CompanyFilterBar } from "@/components/controls/company-filter-bar";
import { DataSourceBanner } from "@/components/ui/data-source-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { distinctCategories, distinctEventTypes, filterCompanies, parseFilters } from "@/lib/filters";
import { daysSince, hourGranularRecencyLabel } from "@/lib/derive/recency";
import Link from "next/link";
import { StartExploring } from "@/components/radar/start-exploring";
import { Eyebrow } from "@/components/ui/eyebrow";

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

  const lastObservedMs = totals.lastObservedAt ? new Date(totals.lastObservedAt).getTime() : null;

  return (
    <main className="mx-auto max-w-[1040px] px-6 pb-16 pt-10 sm:px-8 sm:pt-12">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-line-strong pb-5">
        <div className="max-w-2xl">
          <Eyebrow>Startup Radar</Eyebrow>
          <h1 className="mt-2 font-serif text-2xl leading-snug tracking-tight text-ink sm:text-3xl">A directory of emerging startups, the signals they leave behind, and the evidence worth following.</h1>
        </div>
        {lastObservedMs !== null ? (
          <p className="tabular shrink-0 text-xs text-ink-faint" title={new Date(lastObservedMs).toLocaleString("en-US")}>
            <span aria-hidden className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-live align-middle" />
            Updated {hourGranularRecencyLabel(lastObservedMs)}
          </p>
        ) : null}
      </div>
      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-ink-muted">
        Deterministic discovery — zero fabricated enrichment, domain matches require independent corroboration, never a name match alone.{" "}
        <Link href="/methodology" className="font-medium text-accent hover:underline">Methodology →</Link>
      </p>

      <dl className="mt-6 grid grid-cols-2 border-b border-line sm:grid-cols-3 lg:grid-cols-5">
        {stats.map(([label, value]) => <div key={label} className="border-l border-line py-3.5 pl-4 pr-2 first:border-l-0 first:pl-0 sm:py-4 lg:pl-6"><dt className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">{label}</dt><dd className="tabular mt-1.5 text-2xl font-semibold tracking-tight sm:text-3xl">{value === null ? "N/A" : label === "Total observations" && value >= 1000 ? <span title={value.toLocaleString("en-US")} aria-label={`${value.toLocaleString("en-US")} observations`}>{Math.floor(value / 1000)}K+</span> : value.toLocaleString("en-US")}</dd></div>)}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-ink-muted"><strong className="text-ink">Observations</strong> are recorded measurements; <strong className="text-ink">signals</strong> are rule-derived findings from those observations. <Link href="/methodology" className="text-accent hover:underline">Learn more</Link></p>
      <DataSourceBanner source={source} />
      <details className="mt-6 border border-line px-5 py-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink">How to read Startup Radar</summary>
        <ol className="mt-4 grid gap-4 text-sm leading-relaxed text-ink-muted sm:grid-cols-3">
          <li><strong className="text-ink">01 · Discover.</strong> Browse companies surfaced from public sources.</li>
          <li><strong className="text-ink">02 · Observe.</strong> Scout revisits available GitHub, hiring and website sources.</li>
          <li><strong className="text-ink">03 · Investigate.</strong> Open a profile to inspect signals and follow the original evidence.</li>
        </ol>
        <Link href="/about" className="mt-4 inline-block text-sm font-medium text-accent hover:underline">About the project →</Link>
      </details>
      {source === "supabase" && <StartExploring companies={companies} />}
      <section aria-label="Company directory" className="mt-8">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><Eyebrow>The radar</Eyebrow><h2 className="mt-2 font-serif text-3xl tracking-tight">Companies to watch</h2></div><div className="flex flex-wrap gap-4 text-xs"><a href="/api/companies" className="font-medium text-accent hover:underline">Export JSON</a><a href="/api/companies?format=csv" className="font-medium text-accent hover:underline">Export CSV</a><p className="font-mono uppercase tracking-wider text-ink-faint">{filtered.length} {filtered.length === 1 ? "company" : "companies"}</p></div></div>
        <CompanyFilterBar initial={filters} categories={categories} eventTypes={distinctEventTypes(companies)} variant="full" searchPlaceholder="Search companies, domains or categories…" />
        <div aria-hidden="true" className="mt-8 hidden grid-cols-[3rem_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,2fr)_7rem] gap-4 border-b border-line-strong px-3 pb-3 font-mono text-[10px] font-medium uppercase tracking-[0.15em] text-ink-faint sm:grid"><span>#</span><span>Company</span><span>Category</span><span>Evidence</span><span className="pr-6 text-right">Added</span></div>
        {filtered.length === 0 ? <EmptyState title="No companies match these filters" description="Try widening the discovery window or clearing a filter." /> : <div>{filtered.map((company, index) => <CompanyCard key={company.id} company={company} index={index} />)}</div>}
      </section>
    </main>
  );
}
