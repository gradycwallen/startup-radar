import type { Metadata } from "next";
import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { ExploreCard } from "@/components/explore/explore-card";
import { CompanyFilterBar } from "@/components/controls/company-filter-bar";
import { DataSourceBanner } from "@/components/ui/data-source-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PageBanner } from "@/components/layout/page-banner";
import { distinctCategories, distinctEventTypes, filterCompanies, parseFilters } from "@/lib/filters";

export const metadata: Metadata = { title: "Explore" };

export default async function ExplorePage({ searchParams }: PageProps<"/explore">) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const { source, companies } = await getAllCompaniesWithEvents();
  const filtered = filterCompanies(companies, filters);

  return (
    <>
    <PageBanner compact eyebrow="Explore" title="Browse the company universe">
      Search and filter every company Startup Radar has discovered, useful when you already know roughly what you&rsquo;re
      looking for, or want to browse by category, signal type or confidence.
    </PageBanner>
    <main className="mx-auto max-w-[1040px] px-6 pb-10 pt-8 sm:px-8 sm:pb-12 sm:pt-10">

      <DataSourceBanner source={source} />

      <div className="mt-2">
        <CompanyFilterBar initial={filters} categories={distinctCategories(companies)} eventTypes={distinctEventTypes(companies)} variant="full" searchPlaceholder="Search by name, domain, category or description…" />
      </div>

      <div className="mb-6 mt-6 flex items-baseline justify-between">
        <p className="font-mono text-xs uppercase tracking-[0.08em] text-ink-faint">
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
    </>
  );
}
