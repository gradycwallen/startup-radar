import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActivitySeries } from "../src/lib/derive/activity-series.ts";
import type { SignalObservation, SignalSource } from "../src/lib/data/types.ts";

function obs(overrides: Partial<SignalObservation> = {}): SignalObservation {
  return {
    id: 1, companyId: 1, signalSourceId: 1, metricName: "github_stars", numericValue: 10, textValue: null,
    observedAt: "2026-10-01T00:00:00Z", collectionVersion: "github-v1", metadata: null,
    ...overrides,
  };
}

function source(overrides: Partial<SignalSource> = {}): SignalSource {
  return { id: 1, companyId: 1, sourceType: "github_repo", externalId: "acme/repo", canonicalUrl: null, resolutionMethod: "homepage_link_confirmed", active: true, ...overrides };
}

test("a metric with only one observation is excluded -- nothing to draw a trend from", () => {
  const series = buildActivitySeries([obs({ id: 1, observedAt: "2026-10-01T00:00:00Z" })], [source()]);
  assert.deepEqual(series, []);
});

test("a boolean/presence metric (not a true magnitude) is never charted, even with many readings", () => {
  const points = [1, 2, 3].map((n) => obs({ id: n, metricName: "ats_has_enterprise_sales_role", numericValue: 1, observedAt: `2026-10-0${n}T00:00:00Z` }));
  assert.deepEqual(buildActivitySeries(points, [source()]), []);
});

test("points are sorted oldest-first regardless of input order", () => {
  const series = buildActivitySeries(
    [obs({ id: 2, numericValue: 12, observedAt: "2026-10-05T00:00:00Z" }), obs({ id: 1, numericValue: 10, observedAt: "2026-10-01T00:00:00Z" })],
    [source()],
  );
  assert.equal(series.length, 1);
  assert.deepEqual(
    series[0]!.points.map((p) => p.value),
    [10, 12],
  );
});

test("a flat stretch (same value repeated) is preserved as real points, never collapsed or deduped", () => {
  const points = ["01", "02", "03"].map((d) => obs({ id: Number(d), numericValue: 8, observedAt: `2026-10-${d}T00:00:00Z` }));
  const series = buildActivitySeries(points, [source()]);
  assert.equal(series[0]!.points.length, 3, "three real daily readings stay three points, even though the value never moved");
});

test("a null numeric_value (a metric that wasn't actually observed) is excluded, never treated as zero", () => {
  const series = buildActivitySeries([obs({ id: 1, numericValue: null, observedAt: "2026-10-01T00:00:00Z" }), obs({ id: 2, numericValue: 10, observedAt: "2026-10-02T00:00:00Z" })], [source()]);
  assert.deepEqual(series, [], "only one REAL numeric reading exists -- still below the 2-point minimum");
});

// ---- REGRESSION: multiple signal_sources reporting the SAME metric_name must never be blended --
//
// Found live in production: Restate tracks 8 separate GitHub repos (restate, sdk-typescript,
// sdk-java, ...), each its own signal_source_id, all writing "github_stars". Grouping by
// metric_name alone interleaved unrelated repos' star counts (4500+ mixed with ~60-175) into one
// "series", rendering as a meaningless zigzag on the live site. See
// src/lib/derive/activity-series.ts's module doc comment.

test("REGRESSION: two sources reporting the same metric name produce two SEPARATE series, never one blended/interleaved series", () => {
  const mainRepo = source({ id: 71, externalId: "restatedev/restate" });
  const sdkRepo = source({ id: 72, externalId: "restatedev/sdk-typescript" });
  const observations = [
    obs({ id: 1, signalSourceId: 71, numericValue: 4495, observedAt: "2026-09-30T00:00:00Z" }),
    obs({ id: 2, signalSourceId: 72, numericValue: 123, observedAt: "2026-09-30T00:05:00Z" }),
    obs({ id: 3, signalSourceId: 71, numericValue: 4503, observedAt: "2026-10-01T00:00:00Z" }),
    obs({ id: 4, signalSourceId: 72, numericValue: 123, observedAt: "2026-10-01T00:05:00Z" }),
    obs({ id: 5, signalSourceId: 71, numericValue: 4508, observedAt: "2026-10-02T00:00:00Z" }),
    obs({ id: 6, signalSourceId: 72, numericValue: 124, observedAt: "2026-10-02T00:05:00Z" }),
  ];
  const series = buildActivitySeries(observations, [mainRepo, sdkRepo]);
  assert.equal(series.length, 2, "one series per source, never merged into one");

  const main = series.find((s) => s.signalSourceId === 71)!;
  const sdk = series.find((s) => s.signalSourceId === 72)!;
  assert.deepEqual(main.points.map((p) => p.value), [4495, 4503, 4508], "the main repo's series stays purely in the 4000s -- no SDK values mixed in");
  assert.deepEqual(sdk.points.map((p) => p.value), [123, 123, 124], "the SDK repo's series stays purely in the hundreds -- no main-repo values mixed in");
});

test("REGRESSION: a sourceQualifier is attached ONLY when a company has multiple sources for the same metric -- the common single-source case gets no qualifier", () => {
  const twoRepos = buildActivitySeries(
    [
      obs({ id: 1, signalSourceId: 71, observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 2, signalSourceId: 71, observedAt: "2026-10-02T00:00:00Z" }),
      obs({ id: 3, signalSourceId: 72, observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 4, signalSourceId: 72, observedAt: "2026-10-02T00:00:00Z" }),
    ],
    [source({ id: 71, externalId: "restatedev/restate" }), source({ id: 72, externalId: "restatedev/sdk-typescript" })],
  );
  assert.ok(twoRepos.every((s) => s.sourceQualifier !== null), "two sources sharing a metric name both need a qualifier to tell them apart");
  assert.deepEqual(
    twoRepos.map((s) => s.sourceQualifier).sort(),
    ["restate", "sdk-typescript"],
  );

  const oneRepo = buildActivitySeries(
    [obs({ id: 1, signalSourceId: 71, observedAt: "2026-10-01T00:00:00Z" }), obs({ id: 2, signalSourceId: 71, observedAt: "2026-10-02T00:00:00Z" })],
    [source({ id: 71, externalId: "restatedev/restate" })],
  );
  assert.equal(oneRepo[0]!.sourceQualifier, null, "a single source for this metric needs no qualifier -- the common case stays clean");
});

test("multiple DIFFERENT metrics from the same single source each get their own series, independent of each other", () => {
  const series = buildActivitySeries(
    [
      obs({ id: 1, signalSourceId: 1, metricName: "github_stars", numericValue: 10, observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 2, signalSourceId: 1, metricName: "github_stars", numericValue: 15, observedAt: "2026-10-05T00:00:00Z" }),
      obs({ id: 3, signalSourceId: 1, metricName: "ats_open_jobs_total", numericValue: 2, observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 4, signalSourceId: 1, metricName: "ats_open_jobs_total", numericValue: 5, observedAt: "2026-10-05T00:00:00Z" }),
    ],
    [source({ id: 1 })],
  );
  assert.equal(series.length, 2);
  assert.deepEqual(
    series.map((s) => s.metricName).sort(),
    ["ats_open_jobs_total", "github_stars"],
  );
});
