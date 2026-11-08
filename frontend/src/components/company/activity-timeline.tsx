import { buildActivitySeries, groupSeriesBySource, hasSourceCollision, pickPrimarySourceId } from "@/lib/derive/activity-series";
import type { SignalObservation, SignalSource } from "@/lib/data/types";
import { ActivitySourceFilter } from "./activity-source-filter";
import { ActivitySparkline } from "./activity-sparkline";

/** Renders nothing when there isn't enough real history to chart -- a company with zero or one
 * observation per metric gets no empty/placeholder chart grid, matching the rest of Signal
 * Intelligence's discipline of never showing a chrome box with nothing honest inside it.
 *
 * Most companies have exactly one source per metric and render the plain grid, unchanged from
 * before — the source-filter dropdown only appears for the rarer multi-source case (most
 * commonly a multi-repo GitHub project), so nobody sees new chrome for a problem they don't have. */
export function ActivityTimeline({ observations, sources }: { observations: readonly SignalObservation[]; sources: readonly SignalSource[] }) {
  const series = buildActivitySeries(observations, sources);
  if (series.length === 0) return null;

  const groups = groupSeriesBySource(series);
  const primarySourceId = hasSourceCollision(series) ? pickPrimarySourceId(groups) : null;

  if (primarySourceId === null) {
    return (
      <div className="mt-6">
        <h3 className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">Activity over time</h3>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {series.map((s) => (
            <ActivitySparkline key={`${s.signalSourceId}:${s.metricName}`} series={s} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <ActivitySourceFilter groups={groups} defaultSourceId={primarySourceId} />
    </div>
  );
}
