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
        <PageBanner eyebrow="Insights" title="Dataset trends">
          Aggregate activity across every company Startup Radar tracks.
        </PageBanner>
        <main className="mx-auto max-w-5xl px-6 pb-16 pt-8 sm:px-8">
          <p className="text-sm text-ink-muted">Insights are temporarily unavailable. Please try again later.</p>
        </main>
      </>
    );
  }

  if (data.companies.length === 0) {
    return (
      <>
        <PageBanner eyebrow="Insights" title="Dataset trends">
          Aggregate activity across every company Startup Radar tracks.
        </PageBanner>
        <main className="mx-auto max-w-5xl px-6 pb-16 pt-8 sm:px-8">
          <p className="text-sm text-ink-muted">No companies tracked yet.</p>
        </main>
      </>
    );
  }

  const discoveryVolume = buildWeeklyDiscoveryVolume(data.companies);
  const sourceMix = buildSourceMix(data.companies);

  return (
    <>
      <PageBanner eyebrow="Insights" title="Dataset trends">
        Aggregate activity across every company Startup Radar tracks — discovery volume, signal activity, and where
        companies come from. Every chart here is a real count of real rows; a quiet week is a real zero, never a gap.
      </PageBanner>
      <main className="mx-auto max-w-5xl px-6 pb-16 pt-8 sm:px-8">
        <section>
          <h2 className="font-serif text-2xl text-ink">Discovery volume</h2>
          <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">New companies added to the Radar each week.</p>
          <div className="mt-4">
            <WeeklyBarChart title="New companies per week" buckets={discoveryVolume} />
          </div>
        </section>

        <section className="mt-12">
          <h2 className="font-serif text-2xl text-ink">Signal activity</h2>
          <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
            Deterministic signals derived each week, by family — a confirmed change in hiring, GitHub activity, or website
            structure, not a raw observation count.
          </p>
          {data.signals.length === 0 ? (
            <p className="mt-4 text-sm text-ink-muted">No signals have been derived yet.</p>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(Object.keys(SIGNAL_FAMILY_LABELS) as (keyof typeof SIGNAL_FAMILY_LABELS)[]).map((family) => (
                <WeeklyBarChart key={family} title={SIGNAL_FAMILY_LABELS[family]} buckets={buildWeeklySignalVolume(data.signals, family)} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-12 max-w-2xl">
          <h2 className="font-serif text-2xl text-ink">Where companies come from</h2>
          <p className="mt-1.5 text-sm text-ink-muted">Every company&rsquo;s original discovery source, Scout&rsquo;s own real provider name — never a category guess.</p>
          <div className="mt-4">
            <SourceMixChart entries={sourceMix} />
          </div>
        </section>
      </main>
    </>
  );
}
