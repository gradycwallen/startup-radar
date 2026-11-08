import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActivitySeries, groupSeriesBySource, hasSourceCollision, pickPrimarySourceId } from "../src/lib/derive/activity-series.ts";
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

// ---- groupSeriesBySource / pickPrimarySourceId -------------------------------------------------

test("groupSeriesBySource groups a single source's several metrics together, not one group per metric", () => {
  const series = buildActivitySeries(
    [
      obs({ id: 1, signalSourceId: 1, metricName: "github_stars", observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 2, signalSourceId: 1, metricName: "github_stars", observedAt: "2026-10-02T00:00:00Z" }),
      obs({ id: 3, signalSourceId: 1, metricName: "github_forks", observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 4, signalSourceId: 1, metricName: "github_forks", observedAt: "2026-10-02T00:00:00Z" }),
    ],
    [source({ id: 1 })],
  );
  const groups = groupSeriesBySource(series);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.series.length, 2);
});

test("pickPrimarySourceId returns null when there's only one group -- nothing to choose between, no filter UI needed", () => {
  const series = buildActivitySeries(
    [obs({ id: 1, signalSourceId: 1, observedAt: "2026-10-01T00:00:00Z" }), obs({ id: 2, signalSourceId: 1, observedAt: "2026-10-02T00:00:00Z" })],
    [source({ id: 1 })],
  );
  assert.equal(pickPrimarySourceId(groupSeriesBySource(series)), null);
});

test("pickPrimarySourceId picks the group with the highest latest github_stars value -- the flagship repo, not the first-seen one", () => {
  const series = buildActivitySeries(
    [
      obs({ id: 1, signalSourceId: 72, metricName: "github_stars", numericValue: 123, observedAt: "2026-10-01T00:00:00Z" }), // SDK repo, seen first
      obs({ id: 2, signalSourceId: 72, metricName: "github_stars", numericValue: 126, observedAt: "2026-10-02T00:00:00Z" }),
      obs({ id: 3, signalSourceId: 71, metricName: "github_stars", numericValue: 4495, observedAt: "2026-10-01T00:00:00Z" }), // main repo, far more stars
      obs({ id: 4, signalSourceId: 71, metricName: "github_stars", numericValue: 4673, observedAt: "2026-10-02T00:00:00Z" }),
    ],
    [source({ id: 72, externalId: "restatedev/sdk-typescript" }), source({ id: 71, externalId: "restatedev/restate" })],
  );
  assert.equal(pickPrimarySourceId(groupSeriesBySource(series)), 71, "the main repo (4673 stars) should win over the SDK repo (126 stars), regardless of input order");
});

test("pickPrimarySourceId falls back to total data points, then lowest signalSourceId, when no group has a github_stars series", () => {
  const richer = buildActivitySeries(
    [
      obs({ id: 1, signalSourceId: 2, metricName: "ats_open_jobs_total", numericValue: 2, observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 2, signalSourceId: 2, metricName: "ats_open_jobs_total", numericValue: 3, observedAt: "2026-10-02T00:00:00Z" }),
      obs({ id: 3, signalSourceId: 1, metricName: "github_forks", numericValue: 5, observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 4, signalSourceId: 1, metricName: "github_forks", numericValue: 6, observedAt: "2026-10-02T00:00:00Z" }),
      obs({ id: 5, signalSourceId: 1, metricName: "github_forks", numericValue: 7, observedAt: "2026-10-03T00:00:00Z" }),
    ],
    [source({ id: 1 }), source({ id: 2, sourceType: "greenhouse", externalId: "acme" })],
  );
  assert.equal(pickPrimarySourceId(groupSeriesBySource(richer)), 1, "source 1 has 3 points vs source 2's 2, so it wins on richness");
});

// ---- hasSourceCollision -------------------------------------------------------------------------
//
// REGRESSION (found live, 2026-11-08): GitHits has two active sources (a github_repo and a
// github_org) that report entirely DIFFERENT metrics -- no collision at all -- but the filter UI
// was triggering anyway because it keyed off "more than one distinct source", not "more than one
// source for the SAME metric". A company with several complementary (non-overlapping) sources
// must render the plain flat grid, exactly like a single-source company, never a dropdown.

test("REGRESSION: two sources reporting entirely DIFFERENT metrics have no collision -- the filter must not trigger just because there's more than one source", () => {
  const series = buildActivitySeries(
    [
      obs({ id: 1, signalSourceId: 1, metricName: "github_stars", observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 2, signalSourceId: 1, metricName: "github_stars", observedAt: "2026-10-02T00:00:00Z" }),
      obs({ id: 3, signalSourceId: 2, metricName: "github_org_public_repos", observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 4, signalSourceId: 2, metricName: "github_org_public_repos", observedAt: "2026-10-02T00:00:00Z" }),
    ],
    [source({ id: 1, sourceType: "github_repo" }), source({ id: 2, sourceType: "github_org", externalId: "acme-org" })],
  );
  assert.equal(groupSeriesBySource(series).length, 2, "still two distinct sources...");
  assert.equal(hasSourceCollision(series), false, "...but no collision, since they don't share a metric name");
});

test("hasSourceCollision is true exactly when the Restate-shaped case applies (same metric, multiple sources)", () => {
  const series = buildActivitySeries(
    [
      obs({ id: 1, signalSourceId: 71, metricName: "github_stars", observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 2, signalSourceId: 71, metricName: "github_stars", observedAt: "2026-10-02T00:00:00Z" }),
      obs({ id: 3, signalSourceId: 72, metricName: "github_stars", observedAt: "2026-10-01T00:00:00Z" }),
      obs({ id: 4, signalSourceId: 72, metricName: "github_stars", observedAt: "2026-10-02T00:00:00Z" }),
    ],
    [source({ id: 71, externalId: "restatedev/restate" }), source({ id: 72, externalId: "restatedev/sdk-typescript" })],
  );
  assert.equal(hasSourceCollision(series), true);
});
