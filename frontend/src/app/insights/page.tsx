import type { Metadata } from "next";
import { PageBanner } from "@/components/layout/page-banner";
import { WeeklyBarChart } from "@/components/insights/weekly-bar-chart";
import { SourceMixChart } from "@/components/insights/source-mix-chart";
import { getInsightsData } from "@/lib/data/insights";
import { buildSourceMix, buildWeeklyDiscoveryVolume, buildWeeklySignalVolume } from "@/lib/derive/insights-series";

export const metadata: Metadata = { title: "Insights" };
export const revalidate = 3600;

const SIGNAL_FAMILY_LABELS = { hiring: "Hiring signals", github: "GitHub signals", website: "Website signals" } as const;

export default async function InsightsPage() {
  const data = await getInsightsData();

  if (data.unavailable) {
    return (
      <>
        <PageBanner compact eyebrow="Insights" title="Dataset trends">
          Aggregate activity across every company Startup Radar tracks.
        </PageBanner>
        <main className="mx-auto max-w-7xl px-6 pb-16 pt-8 sm:px-8">
          <p className="text-sm text-ink-muted">Live insights are unavailable. Connect to the database or try again later.</p>
        </main>
      </>
    );
  }

  if (data.companies.length === 0) {
    return (
      <>
        <PageBanner compact eyebrow="Insights" title="Dataset trends">
          Aggregate activity across every company Startup Radar tracks.
        </PageBanner>
        <main className="mx-auto max-w-7xl px-6 pb-16 pt-8 sm:px-8">
          <p className="text-sm text-ink-muted">No companies tracked yet.</p>
        </main>
      </>
    );
  }

  const discoveryVolume = buildWeeklyDiscoveryVolume(data.companies);
  const sourceMix = buildSourceMix(data.companies);

  return (
    <>
      <PageBanner compact eyebrow="Insights" title="Dataset trends">
        A weekly view of discovery and signal activity, plus the sources behind the directory.
      </PageBanner>
      <main className="mx-auto max-w-7xl px-6 pb-16 pt-8 sm:px-8">
        <section>
          <h2 className="text-base font-semibold text-ink">Discovery volume</h2>
          <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">New companies added to the Radar each week.</p>
          <div className="mt-4">
            <WeeklyBarChart title="New companies per week" buckets={discoveryVolume} />
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-base font-semibold text-ink">Signal activity</h2>
          <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
            Signals derived each week from hiring, GitHub activity, and website observations. These include both first-look
            findings and changes detected over time.
          </p>
          {data.signals.length === 0 ? (
            <p className="mt-4 text-sm text-ink-muted">No signals have been derived yet.</p>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-3">
              {(Object.keys(SIGNAL_FAMILY_LABELS) as (keyof typeof SIGNAL_FAMILY_LABELS)[]).map((family) => (
                <WeeklyBarChart key={family} title={SIGNAL_FAMILY_LABELS[family]} buckets={buildWeeklySignalVolume(data.signals, family)} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-10">
          <h2 className="text-base font-semibold text-ink">Where companies come from</h2>
          <p className="mt-1.5 text-sm text-ink-muted">Each company&rsquo;s original discovery source, as recorded by Scout.</p>
          <div className="mt-4">
            <SourceMixChart entries={sourceMix} />
          </div>
        </section>
      </main>
    </>
  );
}
