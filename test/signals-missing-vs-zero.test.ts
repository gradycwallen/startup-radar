import assert from "node:assert/strict";
import { test } from "node:test";
import { bestAvailableWindow, compareWindow, metricSeries } from "../src/signals/velocity.ts";
import { obs } from "./fixtures/signals/scenarios.ts";

/**
 * The non-negotiable rule from the V2-2A.1 brief: a metric that was absent/unavailable at some
 * point in history is UNKNOWN, never zero. These tests prove it holds generically in the
 * observation engine (src/signals/velocity.ts) — not just for GitHub, and not just informally.
 *
 * The mechanism that makes this true: observations are ONE ROW PER (company, metric, time),
 * written ONLY when a collector actually obtained a value (see src/signals/sources/github.ts and
 * ats/*.ts — a metric a collector couldn't retrieve is simply never pushed to its output array).
 * There is no dense/interpolated timeline and nothing here ever backfills a gap with 0 or null-
 * as-zero. `metricSeries`/`compareWindow` only ever see rows that were actually written.
 */

test("1. missing PREVIOUS metric != zero: a metric first observed today has no prior value to compare against, not an implicit 0", () => {
  // contributors was simply never observed before today — no row exists for it at any earlier time.
  const history = [obs(1, 1, "github_contributors", 14, 0)];
  const cmp = compareWindow(history, "github_contributors", 30);
  assert.equal(cmp!.sufficientHistory, false, "no prior observation exists, so there is nothing to compare against — NOT a comparison against 0");
  assert.equal(cmp!.from, null);
  assert.equal(cmp!.delta, null, "delta must be null, not 14 (which is what '0 -> 14' would incorrectly imply)");
});

test("2. missing CURRENT metric != zero: a metric that was observed before but not this time has no current value, not an implicit 0", () => {
  // github_stars was observed 30 days ago (1200) but the most recent collection didn't include it
  // (e.g. that field was temporarily absent from the API response) — no row was written for "now".
  const history = [obs(1, 1, "github_stars", 1200, 30)];
  // The metric's own series has no "current" point at all — compareWindow reports based on what
  // actually exists: the single old observation is the latest THING WE HAVE, not "current = 0".
  const series = metricSeries(history, "github_stars");
  assert.equal(series.length, 1);
  assert.equal(series[0]!.numeric_value, 1200, "the only data point is the 30-day-old one — nothing claims a current value of 0");
});

test("3. a newly introduced metric does not generate a false increase on its first observation", () => {
  // Simulates a collector upgrade that starts reporting a metric it never reported before.
  const history = [obs(1, 1, "github_open_issues", 3, 30), obs(1, 1, "github_open_issues", 5, 0), obs(1, 1, "ats_open_jobs_legal", 2, 0) /* brand new metric */];
  const legal = bestAvailableWindow(history, "ats_open_jobs_legal");
  assert.equal(legal, null, "a metric with exactly one observation ever has no window comparison at all — never reported as '0 -> 2'");
});

test("4. a temporarily unavailable metric does not generate a false decrease when it reappears", () => {
  // stars: observed day30 (1200) and day0 (1500); commits: observed day30 (40) but NOT day0 (API
  // hiccup — no row written for that pass) — commits reappearing later must not look like a drop to 0.
  const history = [
    obs(1, 1, "github_stars", 1200, 30),
    obs(1, 1, "github_commits_last_4w", 40, 30),
    obs(1, 1, "github_stars", 1500, 0),
    // NOTE: deliberately no github_commits_last_4w row at day 0 — that collection pass didn't get it.
  ];
  const commits = bestAvailableWindow(history, "github_commits_last_4w");
  assert.equal(commits, null, "only one observation of commits exists (day30) — there is no 'current' value, so no delta, and certainly not '40 -> 0'");
  const commitsSeries = metricSeries(history, "github_commits_last_4w");
  assert.deepEqual(commitsSeries.map((o) => o.numeric_value), [40], "the gap is simply absent from the series, not filled with a 0");
});

test("5. velocity begins only once sufficient comparable observations exist for that SPECIFIC metric", () => {
  const history = [obs(1, 1, "ats_open_jobs_total", 3, 10)]; // one point, 10 days old
  assert.equal(bestAvailableWindow(history, "ats_open_jobs_total"), null, "one observation, however old, is still insufficient — there is no second point to compare against");
  const withSecond = [...history, obs(1, 1, "ats_open_jobs_total", 9, 0)];
  const cmp = bestAvailableWindow(withSecond, "ats_open_jobs_total");
  assert.ok(cmp !== null && cmp.sufficientHistory, "a second, sufficiently-spaced observation now makes a comparison possible");
});

test("6. a LEGITIMATE observed zero remains distinguishable from unknown — an actual 0 is real data, not a gap", () => {
  // The ATS collector's aggregation (src/signals/sources/ats/aggregate.ts) reports every role
  // category on every successful job-list fetch, including categories with genuinely zero open
  // roles — that 0 came from a real, successful response, unlike a metric that was never written.
  const history = [obs(1, 1, "ats_open_jobs_sales", 0, 30), obs(1, 1, "ats_open_jobs_sales", 4, 0)];
  const cmp = compareWindow(history, "ats_open_jobs_sales", 30)!;
  assert.equal(cmp.sufficientHistory, true, "0 is a real prior observation, usable in a comparison — NOT the same as no observation at all");
  assert.equal(cmp.from!.numeric_value, 0);
  assert.equal(cmp.fromWasZero, true);
  assert.equal(cmp.delta, 4, "0 -> 4 is a legitimate, real delta because both points were actually observed");
});

test("7. adding a new collector metric later does not corrupt older, unrelated observation history", () => {
  // Old metrics (recorded under collection_version 'github-v1') keep their own untouched series
  // even after a newer pass introduces a brand-new metric name alongside them.
  const history = [
    obs(1, 1, "github_stars", 100, 30, { collection_version: "github-v1" }),
    obs(1, 1, "github_stars", 150, 0, { collection_version: "github-v1" }),
    obs(1, 1, "github_org_public_repos", 9, 0, { collection_version: "github-v1" }), // introduced only in the latest pass
  ];
  const stars = bestAvailableWindow(history, "github_stars")!;
  assert.deepEqual([stars.from!.numeric_value, stars.to.numeric_value, stars.delta], [100, 150, 50], "the pre-existing stars series is completely unaffected by the new metric appearing alongside it");
  assert.equal(bestAvailableWindow(history, "github_org_public_repos"), null, "the brand-new metric correctly has no velocity yet, on its own, independent of stars");
});
