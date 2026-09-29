import type { Metadata } from "next";
import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { ExploreCard } from "@/components/explore/explore-card";
import { CompanyFilterBar } from "@/components/controls/company-filter-bar";
import { DataSourceBanner } from "@/components/ui/data-source-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { distinctCategories, distinctEventTypes, filterCompanies, parseFilters } from "@/lib/filters";

export const metadata: Metadata = { title: "Explore" };

export default async function ExplorePage({ searchParams }: PageProps<"/explore">) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const { source, companies } = await getAllCompaniesWithEvents();
  const filtered = filterCompanies(companies, filters);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-8">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Explore</p>
        <h1 className="mt-1.5 font-serif text-3xl text-ink">Browse the company universe</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Search and filter every company Startup Radar has discovered — useful when you already know roughly what you&rsquo;re
          looking for, or want to browse by category, signal type or confidence.
        </p>
      </div>

      <DataSourceBanner source={source} />

      <div className="mb-6 rounded-lg border border-line bg-surface/60 p-4">
        <CompanyFilterBar initial={filters} categories={distinctCategories(companies)} eventTypes={distinctEventTypes(companies)} variant="full" searchPlaceholder="Search by name, domain, category or description…" />
      </div>

      <div className="mb-4 flex items-baseline justify-between">
        <p className="text-sm text-ink-faint">
          {filtered.length} of {companies.length} {companies.length === 1 ? "company" : "companies"}
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="Nothing matches these filters" description="Try a broader search term, or clear a filter to widen the results." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((company) => (
            <ExploreCard key={company.id} company={company} />
          ))}
        </div>
      )}
    </main>
  );
}
