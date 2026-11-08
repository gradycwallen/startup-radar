import { buildActivitySeries } from "@/lib/derive/activity-series";
import type { SignalObservation, SignalSource } from "@/lib/data/types";
import { ActivitySparkline } from "./activity-sparkline";

/** Renders nothing when there isn't enough real history to chart -- a company with zero or one
 * observation per metric gets no empty/placeholder chart grid, matching the rest of Signal
 * Intelligence's discipline of never showing a chrome box with nothing honest inside it. */
export function ActivityTimeline({ observations, sources }: { observations: readonly SignalObservation[]; sources: readonly SignalSource[] }) {
  const series = buildActivitySeries(observations, sources);
  if (series.length === 0) return null;

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
