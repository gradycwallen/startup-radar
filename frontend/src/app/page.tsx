import { getAllCompaniesWithEvents } from "@/lib/data/companies";
import { CompanyCard } from "@/components/radar/company-card";
import { CompanyFilterBar } from "@/components/controls/company-filter-bar";
import { DataSourceBanner } from "@/components/ui/data-source-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { RadarIntro } from "@/components/intro/radar-intro";
import { distinctCategories, distinctEventTypes, filterCompanies, parseFilters } from "@/lib/filters";
import { daysSince } from "@/lib/derive/recency";
import { compareMomentumDesc } from "@/lib/derive/momentum";

export default async function RadarPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const { source, companies } = await getAllCompaniesWithEvents();
  const filtered = filterCompanies(companies, filters);

  const newThisWeek = companies.filter((c) => daysSince(c.discoveredAt) <= 7).length;
  const categoryCount = distinctCategories(companies).length;
  const signalTypeCount = distinctEventTypes(companies).length;
  const sourceCount = new Set(companies.map((c) => c.discoverySource).filter((s): s is string => Boolean(s))).size;

  // The intro's "detections" are the same top-momentum companies Momentum would rank first on
  // the real feed below (compareMomentumDesc, unchanged) — never a separately-invented list —
  // so scrolling past the intro into the feed shows exactly what it just claimed to find.
  const topSignals = [...companies]
    .sort(compareMomentumDesc)
    .slice(0, 6)
    .map((c) => ({ name: c.name, domain: c.domain }));

  return (
    <>
      {/* Scroll-revealed cover, only on the homepage — see radar-intro.tsx for the mechanics.
          Deliberately outside <main>: it's a threshold you scroll through, not page content. */}
      <RadarIntro topSignals={topSignals} totalCount={companies.length} sourceCount={sourceCount} signalTypeCount={signalTypeCount} />

      {/* Wide enough to use a real desktop monitor (a narrower max-w-3xl read as a tiny column
          stranded in a sea of margin on a large screen — found in review); the feed row itself
          (company-card.tsx) spreads its own content across this width via justify-between rather
          than leaving it centered in a too-narrow tube. */}
      <main className="mx-auto max-w-7xl px-6 py-10 sm:px-8 sm:py-16">
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
            count over the same `companies` this page renders, never a separately-computed figure.
            One rule (top only), not a boxed pair — see the line-density note below. */}
        <dl className="mt-14 flex flex-wrap gap-x-12 gap-y-5 border-t border-line pt-7">
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
            the deep-filter tool Explore is. Full filtering lives on /explore. Generous margin
            instead of another rule here — see the line-density note above. */}
        <div className="mt-14">
          <CompanyFilterBar initial={filters} categories={distinctCategories(companies)} eventTypes={distinctEventTypes(companies)} variant="compact" searchPlaceholder="Search the radar by name, domain or category…" />
        </div>

        <div className="mb-2 mt-8 flex items-baseline justify-between">
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
    </>
  );
}
