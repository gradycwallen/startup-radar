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
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-16">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Explore</p>
        <h1 className="mt-3 font-serif text-4xl leading-[1.05] tracking-tight text-ink sm:text-5xl">Browse the company universe</h1>
        <p className="mt-5 text-base leading-relaxed text-ink-muted">
          Search and filter every company Startup Radar has discovered — useful when you already know roughly what you&rsquo;re
          looking for, or want to browse by category, signal type or confidence.
        </p>
      </div>

      <DataSourceBanner source={source} />

      <div className="mt-10">
        <CompanyFilterBar initial={filters} categories={distinctCategories(companies)} eventTypes={distinctEventTypes(companies)} variant="full" searchPlaceholder="Search by name, domain, category or description…" />
      </div>

      <div className="mb-6 mt-6 flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">
          {filtered.length} of {companies.length} {companies.length === 1 ? "company" : "companies"}
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="Nothing matches these filters" description="Try a broader search term, or clear a filter to widen the results." />
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((company) => (
            <ExploreCard key={company.id} company={company} />
          ))}
        </div>
      )}
    </main>
  );
}
