import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { CompanyCard } from "@/components/radar/company-card";
import { CompanyFilterBar } from "@/components/controls/company-filter-bar";
import { DataSourceBanner } from "@/components/ui/data-source-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { distinctCategories, distinctEventTypes, filterCompanies, parseFilters } from "@/lib/filters";
import { daysSince } from "@/lib/derive/recency";

export default async function RadarPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const { source, companies } = await getAllCompaniesWithEvents();
  const filtered = filterCompanies(companies, filters);

  const newThisWeek = companies.filter((c) => daysSince(c.discoveredAt) <= 7).length;
  const categoryCount = distinctCategories(companies).length;

  return (
    // Narrower than Explore's max-w-6xl on purpose: the Radar is a chronological feed, not a
    // browse grid, and single-column cards stretched to 1152px left a lot of empty space between
    // each card's text and its right-aligned badges on a real desktop monitor.
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">The Radar</p>
        <h1 className="mt-3 font-serif text-[2.75rem] leading-[1.03] tracking-tight text-ink sm:text-6xl">
          Recently discovered startups
        </h1>
        <p className="mt-5 text-base leading-relaxed text-ink-muted sm:text-lg">
          Companies Startup Radar&rsquo;s Scout has surfaced from funding announcements, stealth launches, accelerator cohorts and
          product releases — ranked by recency, with the evidence behind every entry.
        </p>
      </div>

      {/* A spec-sheet stat strip, not another card — big tabular numerals carry the "this is a
          real, live dataset" signal that a paragraph alone can't. Every number here is a direct
          count over the same `companies` this page renders, never a separately-computed figure. */}
      <dl className="mt-10 flex flex-wrap gap-x-10 gap-y-5 border-y border-line py-6">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">Companies tracked</dt>
          <dd className="tabular mt-1 font-serif text-4xl text-ink sm:text-5xl">{companies.length}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">New this week</dt>
          <dd className="tabular mt-1 font-serif text-4xl text-ink sm:text-5xl">{newThisWeek}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint">Categories</dt>
          <dd className="tabular mt-1 font-serif text-4xl text-ink sm:text-5xl">{categoryCount}</dd>
        </div>
      </dl>

      <DataSourceBanner source={source} />

      {/* Compact bar, no boxed panel — the Radar is meant to feel like a fast-moving feed, not
          the deep-filter tool Explore is. Full filtering lives on /explore. */}
      <div className="mt-10">
        <CompanyFilterBar initial={filters} categories={distinctCategories(companies)} eventTypes={distinctEventTypes(companies)} variant="compact" searchPlaceholder="Search the radar by name, domain or category…" />
      </div>

      <div className="mb-2 mt-6 flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">
          {filtered.length} {filtered.length === 1 ? "company" : "companies"}
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No companies match these filters" description="Try widening the discovery window or clearing a filter." />
      ) : (
        <div className="divide-y divide-line">
          {filtered.map((company) => (
            <CompanyCard key={company.id} company={company} />
          ))}
        </div>
      )}
    </main>
  );
}
