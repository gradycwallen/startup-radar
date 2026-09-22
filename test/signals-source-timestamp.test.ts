import assert from "node:assert/strict";
import { test } from "node:test";
import { bestAvailableWindow, compareWindow, metricSeries } from "../src/signals/velocity.ts";
import type { Observation } from "../src/signals/types.ts";

/**
 * V2-2B.1 — source_timestamp-aware history. `compareWindow`/`metricSeries` now order and window
 * observations by `source_timestamp` when present, falling back to `observed_at` otherwise. This
 * is what makes GitHub backfill's REAL historical dates actually usable by velocity math, without
 * ever mutating `observed_at` (which stays an honest "when we captured this").
 */

let nextId = 1;
function obs(overrides: Partial<Observation> & Pick<Observation, "metric_name" | "numeric_value">): Observation {
  return {
    id: nextId++, company_id: 1, signal_source_id: 1, text_value: null,
    observed_at: "2026-09-22T00:00:00Z", source_timestamp: null, collection_version: "test-v1", raw_payload_ref: null,
    ...overrides,
  };
}

test("source_timestamp is PREFERRED when present: a backfilled row's real historical date is used for windowing, not its observed_at (backfill collection time)", () => {
  // Both rows were WRITTEN (observed_at) on the same day — a backfill pass — but represent commit
  // activity from two genuinely different real weeks (source_timestamp).
  const history = [
    obs({ metric_name: "github_commits_last_4w", numeric_value: 8, observed_at: "2026-09-22T00:00:00Z", source_timestamp: "2026-08-01T00:00:00Z" }),
    obs({ metric_name: "github_commits_last_4w", numeric_value: 40, observed_at: "2026-09-22T00:00:00Z", source_timestamp: "2026-09-20T00:00:00Z" }),
  ];
  const cmp = compareWindow(history, "github_commits_last_4w", 30);
  assert.ok(cmp?.sufficientHistory, "a ~50-day real gap (source_timestamp) should satisfy a 30-day window even though observed_at shows zero gap");
  assert.equal(cmp!.from!.numeric_value, 8);
  assert.equal(cmp!.to.numeric_value, 40);
  assert.ok(cmp!.actualSpanDays! > 40, `expected the real source-dated span (~50 days), got ${cmp!.actualSpanDays}`);
});

test("observed_at is the FALLBACK when source_timestamp is absent — unchanged behavior for ordinary live-collected observations", () => {
  const history = [
    obs({ metric_name: "ats_open_jobs_total", numeric_value: 5, observed_at: "2026-08-01T00:00:00Z", source_timestamp: null }),
    obs({ metric_name: "ats_open_jobs_total", numeric_value: 9, observed_at: "2026-09-22T00:00:00Z", source_timestamp: null }),
  ];
  const cmp = compareWindow(history, "ats_open_jobs_total", 30);
  assert.ok(cmp?.sufficientHistory);
  assert.equal(cmp!.from!.numeric_value, 5);
  assert.equal(cmp!.to.numeric_value, 9);
});

test("mixed historical (source_timestamp) + prospective/live (no source_timestamp) observations order correctly together", () => {
  const history = [
    // A backfilled point from ~60 days before "now", written today.
    obs({ metric_name: "github_commits_last_4w", numeric_value: 5, observed_at: "2026-09-22T00:00:00Z", source_timestamp: "2026-07-24T00:00:00Z" }),
    // A live point collected for real 30 days later (no source_timestamp — ordinary live collection).
    obs({ metric_name: "github_commits_last_4w", numeric_value: 15, observed_at: "2026-08-23T00:00:00Z", source_timestamp: null }),
    // Today's live point.
    obs({ metric_name: "github_commits_last_4w", numeric_value: 30, observed_at: "2026-09-22T00:00:00Z", source_timestamp: null }),
  ];
  const series = metricSeries(history, "github_commits_last_4w");
  assert.deepEqual(series.map((o) => o.numeric_value), [5, 15, 30], "series must be ordered by EFFECTIVE timestamp (source_timestamp ?? observed_at), not raw observed_at (which would wrongly put the backfilled 5 last)");
  // bestAvailableWindow prefers the LARGEST sufficient window: 90 days back from "to" (Sep 22) is
  // Jun 24, which the backfilled point (Jul 24) does not reach — so 90d is insufficient and the
  // 30-day window (cutoff Aug 23) is used instead, correctly picking the live Aug 23 point (15) as
  // "from", not the older backfilled one. This is the CORRECT "largest sufficient window" behavior
  // (see bestAvailableWindow's own doc comment) — it is not evidence the backfilled point is unused
  // (the 90-day-window test in this file exercises that case directly).
  const best = bestAvailableWindow(history, "github_commits_last_4w");
  assert.equal(best?.windowDays, 30);
  assert.equal(best?.from?.numeric_value, 15);
  assert.equal(best?.to.numeric_value, 30);
});

test("compareWindow's actualSpanDays reflects the REAL (source_timestamp-based) gap, not the observed_at collection gap", () => {
  const history = [
    obs({ metric_name: "github_commits_last_4w", numeric_value: 4, observed_at: "2026-09-22T00:00:00Z", source_timestamp: "2026-06-24T00:00:00Z" }), // ~90 days before "to"
    obs({ metric_name: "github_commits_last_4w", numeric_value: 50, observed_at: "2026-09-22T00:00:00Z", source_timestamp: "2026-09-22T00:00:00Z" }),
  ];
  const cmp = compareWindow(history, "github_commits_last_4w", 90);
  assert.ok(cmp?.sufficientHistory);
  assert.ok(cmp!.actualSpanDays! >= 89 && cmp!.actualSpanDays! <= 91, `expected ~90 real days, got ${cmp!.actualSpanDays}`);
});

test("never mutates observed_at: the source_timestamp preference changes ORDERING/WINDOWING only — the raw rows passed in are untouched", () => {
  const original: Observation = obs({ metric_name: "github_commits_last_4w", numeric_value: 4, observed_at: "2026-09-22T00:00:00Z", source_timestamp: "2026-06-24T00:00:00Z" });
  const before = { ...original };
  compareWindow([original], "github_commits_last_4w", 90);
  assert.deepEqual(original, before, "compareWindow must be a pure read — never writes back to the observation objects it's given");
});

test("a genuinely equal-timestamp tie (same effective time on both) is handled without throwing and without inventing a fake ordering", () => {
  const history = [
    obs({ metric_name: "github_commits_last_4w", numeric_value: 4, observed_at: "2026-09-01T00:00:00Z", source_timestamp: "2026-09-01T00:00:00Z" }),
    obs({ metric_name: "github_commits_last_4w", numeric_value: 4, observed_at: "2026-09-01T00:00:00Z", source_timestamp: "2026-09-01T00:00:00Z" }),
  ];
  assert.doesNotThrow(() => compareWindow(history, "github_commits_last_4w", 7));
});
