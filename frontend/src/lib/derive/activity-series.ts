import type { SignalObservation, SignalSource } from "@/lib/data/types";

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
 *
 * REGRESSION (found live, 2026-11-08): a company can have MULTIPLE signal_sources reporting the
 * same metric_name — e.g. Restate tracks 8 separate GitHub repos (restate, sdk-typescript,
 * sdk-java, ...), each its own signal_source_id, all writing "github_stars". Grouping by
 * metric_name alone interleaves unrelated repos' star counts (4500+ mixed with ~60-175) into one
 * "series", rendering as a meaningless zigzag. Every series here is now scoped to ONE
 * (signalSourceId, metricName) pair — never blended across sources, even when they share a metric
 * name. See test/activity-series.test.ts's "REGRESSION" cases for the exact shape of this bug.
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
  signalSourceId: number;
  /** The source's own short identifier (e.g. a repo's "owner/repo" external_id), present ONLY
   * when this company has more than one active source reporting the same metric_name — the
   * common case (one GitHub repo, one ATS board) needs no qualifier at all. */
  sourceQualifier: string | null;
  points: ActivitySeriesPoint[];
}

/** A short, human-scannable tail of a source's external_id — "restatedev/sdk-typescript" ->
 * "sdk-typescript" — just enough to tell two same-metric sources apart, never the full slug. */
function shortSourceLabel(externalId: string): string {
  const parts = externalId.split("/");
  return parts[parts.length - 1] || externalId;
}

/** One series per (signalSourceId, metricName) pair with at least 2 real observations — a single
 * point has nothing to draw a trend from and is better left to the existing "first observation"
 * signal card treatment. Sorted oldest-first, stable order (first-seen in the input). */
export function buildActivitySeries(observations: readonly SignalObservation[], sources: readonly SignalSource[]): ActivitySeries[] {
  const bySourceAndMetric = new Map<string, ActivitySeriesPoint[]>();
  const metricNameBySource = new Map<string, string>();
  for (const o of observations) {
    if (!CHARTABLE_METRICS.has(o.metricName) || o.numericValue === null) continue;
    const key = `${o.signalSourceId}:${o.metricName}`;
    const point = { observedAt: o.observedAt, value: o.numericValue };
    const list = bySourceAndMetric.get(key);
    if (list) list.push(point);
    else {
      bySourceAndMetric.set(key, [point]);
      metricNameBySource.set(key, o.metricName);
    }
  }

  // How many DISTINCT sources report each metric name — only those metrics need a qualifier.
  const sourceCountByMetric = new Map<string, number>();
  for (const key of bySourceAndMetric.keys()) {
    const metricName = metricNameBySource.get(key)!;
    sourceCountByMetric.set(metricName, (sourceCountByMetric.get(metricName) ?? 0) + 1);
  }
  const externalIdBySourceId = new Map(sources.map((s) => [s.id, s.externalId]));

  const out: ActivitySeries[] = [];
  for (const [key, points] of bySourceAndMetric) {
    if (points.length < 2) continue;
    const metricName = metricNameBySource.get(key)!;
    const signalSourceId = Number(key.split(":")[0]);
    const needsQualifier = (sourceCountByMetric.get(metricName) ?? 0) > 1;
    const externalId = externalIdBySourceId.get(signalSourceId);
    out.push({
      metricName,
      signalSourceId,
      sourceQualifier: needsQualifier && externalId ? shortSourceLabel(externalId) : null,
      points: [...points].sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
    });
  }
  return out;
}
