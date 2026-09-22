import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { CompanyCard } from "@/components/radar/company-card";
import { CompanyFilterBar } from "@/components/controls/company-filter-bar";
import { DataSourceBanner } from "@/components/ui/data-source-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { distinctCategories, distinctEventTypes, filterCompanies, parseFilters } from "@/lib/filters";

export default async function RadarPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const { source, companies } = await getAllCompaniesWithEvents();
  const filtered = filterCompanies(companies, filters);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">The Radar</p>
        <h1 className="mt-1.5 font-serif text-3xl text-ink">Recently discovered startups</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Companies Startup Radar&rsquo;s Scout has surfaced from funding announcements, stealth launches, accelerator cohorts and
          product releases — ranked by recency, with the evidence behind every entry.
        </p>
      </div>

      <DataSourceBanner source={source} />

      <div className="mb-6 rounded-lg border border-line bg-surface/60 p-4">
        <CompanyFilterBar initial={filters} categories={distinctCategories(companies)} eventTypes={distinctEventTypes(companies)} variant="full" searchPlaceholder="Search the radar by name, domain or category…" />
      </div>

      <div className="mb-4 flex items-baseline justify-between">
        <p className="text-sm text-ink-faint">
          {filtered.length} {filtered.length === 1 ? "company" : "companies"}
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No companies match these filters" description="Try widening the discovery window or clearing a filter." />
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((company) => (
            <CompanyCard key={company.id} company={company} />
          ))}
        </div>
      )}
    </main>
  );
}
