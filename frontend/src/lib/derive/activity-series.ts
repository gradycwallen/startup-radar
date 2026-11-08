import type { SignalObservation } from "@/lib/data/types";

/**
 * Turns raw observation rows into per-metric chronological series for the company-detail
 * activity timeline. Deliberately narrow: only genuine MAGNITUDE metrics (counts that can
 * meaningfully trend up/down/flat) are chartable here — the has_X boolean flags and website
 * presence markers already have a dedicated, honest treatment as signal cards (appeared/not);
 * plotting a 0/1 step function next to them would just restate the same fact worse.
 *
 * No smoothing, no deduping same-day readings, no interpolation across a gap: every point here
 * is a real row the collector actually wrote. A flat stretch IS real information (the metric
 * genuinely didn't move that day, not "no data") — see the missing-vs-zero discipline in
 * CLAUDE.md §11; this module doesn't fabricate a point where none was observed, and doesn't erase
 * a point just because its neighbor has the same value.
 */

const CHARTABLE_METRICS = new Set([
  "github_stars",
  "github_forks",
  "github_open_issues",
  "github_contributors",
  "github_commits_last_4w",
  "github_org_public_repos",
  "ats_open_jobs_total",
  "ats_open_jobs_engineering",
  "ats_open_jobs_sales",
]);

export interface ActivitySeriesPoint {
  observedAt: string;
  value: number;
}

export interface ActivitySeries {
  metricName: string;
  points: ActivitySeriesPoint[];
}

/** One series per chartable metric with at least 2 real observations — a single point has
 * nothing to draw a trend from and is better left to the existing "first observation" signal
 * card treatment. Sorted oldest-first, stable metric order (first-seen in the input). */
export function buildActivitySeries(observations: readonly SignalObservation[]): ActivitySeries[] {
  const byMetric = new Map<string, ActivitySeriesPoint[]>();
  for (const o of observations) {
    if (!CHARTABLE_METRICS.has(o.metricName) || o.numericValue === null) continue;
    const list = byMetric.get(o.metricName);
    const point = { observedAt: o.observedAt, value: o.numericValue };
    if (list) list.push(point);
    else byMetric.set(o.metricName, [point]);
  }
  const out: ActivitySeries[] = [];
  for (const [metricName, points] of byMetric) {
    if (points.length < 2) continue;
    out.push({ metricName, points: [...points].sort((a, b) => a.observedAt.localeCompare(b.observedAt)) });
  }
  return out;
}
