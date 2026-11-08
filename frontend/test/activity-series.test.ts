import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActivitySeries } from "../src/lib/derive/activity-series.ts";
import type { SignalObservation } from "../src/lib/data/types.ts";

function obs(overrides: Partial<SignalObservation> = {}): SignalObservation {
  return {
    id: 1, companyId: 1, signalSourceId: 1, metricName: "github_stars", numericValue: 10, textValue: null,
    observedAt: "2026-10-01T00:00:00Z", collectionVersion: "github-v1", metadata: null,
    ...overrides,
  };
}

test("a metric with only one observation is excluded -- nothing to draw a trend from", () => {
  const series = buildActivitySeries([obs({ id: 1, observedAt: "2026-10-01T00:00:00Z" })]);
  assert.deepEqual(series, []);
});

test("a boolean/presence metric (not a true magnitude) is never charted, even with many readings", () => {
  const points = [1, 2, 3].map((n) => obs({ id: n, metricName: "ats_has_enterprise_sales_role", numericValue: 1, observedAt: `2026-10-0${n}T00:00:00Z` }));
  assert.deepEqual(buildActivitySeries(points), []);
});

test("points are sorted oldest-first regardless of input order", () => {
  const series = buildActivitySeries([
    obs({ id: 2, numericValue: 12, observedAt: "2026-10-05T00:00:00Z" }),
    obs({ id: 1, numericValue: 10, observedAt: "2026-10-01T00:00:00Z" }),
  ]);
  assert.equal(series.length, 1);
  assert.deepEqual(
    series[0]!.points.map((p) => p.value),
    [10, 12],
  );
});

test("a flat stretch (same value repeated) is preserved as real points, never collapsed or deduped", () => {
  const points = ["01", "02", "03"].map((d) => obs({ id: Number(d), numericValue: 8, observedAt: `2026-10-${d}T00:00:00Z` }));
  const series = buildActivitySeries(points);
  assert.equal(series[0]!.points.length, 3, "three real daily readings stay three points, even though the value never moved");
});

test("multiple metrics each get their own series, independent of each other", () => {
  const series = buildActivitySeries([
    obs({ id: 1, metricName: "github_stars", numericValue: 10, observedAt: "2026-10-01T00:00:00Z" }),
    obs({ id: 2, metricName: "github_stars", numericValue: 15, observedAt: "2026-10-05T00:00:00Z" }),
    obs({ id: 3, metricName: "ats_open_jobs_total", numericValue: 2, observedAt: "2026-10-01T00:00:00Z" }),
    obs({ id: 4, metricName: "ats_open_jobs_total", numericValue: 5, observedAt: "2026-10-05T00:00:00Z" }),
  ]);
  assert.equal(series.length, 2);
  assert.deepEqual(
    series.map((s) => s.metricName).sort(),
    ["ats_open_jobs_total", "github_stars"],
  );
});

test("a null numeric_value (a metric that wasn't actually observed) is excluded, never treated as zero", () => {
  const series = buildActivitySeries([obs({ id: 1, numericValue: null, observedAt: "2026-10-01T00:00:00Z" }), obs({ id: 2, numericValue: 10, observedAt: "2026-10-02T00:00:00Z" })]);
  assert.deepEqual(series, [], "only one REAL numeric reading exists -- still below the 2-point minimum");
});
