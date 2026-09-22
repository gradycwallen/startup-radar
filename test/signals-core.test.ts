import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSignalsForCompany } from "../src/signals/observe.ts";
import { bestAvailableWindow, compareWindow, isPersistent, metricSeries } from "../src/signals/velocity.ts";
import {
  SCENARIO_A, SCENARIO_A_COMPANY_ID, SCENARIO_B, SCENARIO_B_COMPANY_ID, SCENARIO_C, SCENARIO_C_COMPANY_ID,
  SCENARIO_D, SCENARIO_D_COMPANY_ID, SCENARIO_E, SCENARIO_E2, SCENARIO_E2_COMPANY_ID, SCENARIO_E_COMPANY_ID,
  SCENARIO_F, SCENARIO_F_COMPANY_ID, obs,
} from "./fixtures/signals/scenarios.ts";

// ---- velocity/window primitives ------------------------------------------------------------------------------------

test("compareWindow: a single observation reports insufficient history explicitly (not silently null, not a guess)", () => {
  const o = obs(1, 1, "x", 5, 0);
  const cmp = compareWindow([o], "x", 30)!;
  assert.deepEqual([cmp.sufficientHistory, cmp.from, cmp.delta, cmp.relativeChange], [false, null, null, null]);
  assert.equal(cmp.to, o);
});

test("compareWindow: truly no data for that metric at all returns null", () => {
  assert.equal(compareWindow([], "x", 30), null);
});

test("compareWindow: is STRICT about window coverage — two observations 3 days apart never produce a '30-day' comparison", () => {
  const older = obs(1, 1, "x", 2, 3);
  const newer = obs(1, 1, "x", 5, 0);
  const window30 = compareWindow([older, newer], "x", 30);
  assert.equal(window30!.sufficientHistory, false, "3 days of history cannot back a 30-day claim");
  const window3 = compareWindow([older, newer], "x", 3);
  assert.deepEqual([window3!.sufficientHistory, window3!.delta, window3!.actualSpanDays], [true, 3, 3]);
});

test("bestAvailableWindow: prefers the LARGEST window with sufficient history, never invents a tighter one", () => {
  const history = [obs(1, 1, "x", 1, 90), obs(1, 1, "x", 2, 45), obs(1, 1, "x", 3, 10), obs(1, 1, "x", 4, 0)];
  const best = bestAvailableWindow(history, "x");
  assert.equal(best!.windowDays, 90, "90d has sufficient history (an observation 90 days old exists) and is tried first");
  const tenDayGap = [obs(1, 1, "x", 1, 10), obs(1, 1, "x", 2, 0)];
  assert.equal(bestAvailableWindow(tenDayGap, "x")!.windowDays, 7, "a 10-day gap clears the 7-day window but not 14/30/90, so 7d is the best available");
  const fiveDayGap = [obs(1, 1, "x", 1, 5), obs(1, 1, "x", 2, 0)];
  assert.equal(bestAvailableWindow(fiveDayGap, "x"), null, "a 5-day gap does not even clear the smallest standard window (7d) — no window is invented to fit it");
});

test("bestAvailableWindow: null (no signal possible) when nothing qualifies for any standard window", () => {
  assert.equal(bestAvailableWindow([obs(1, 1, "x", 1, 1), obs(1, 1, "x", 2, 0)], "x"), null);
});

test("isPersistent: a value flat right up to the latest reading, then a spike, is NOT persistent; genuine late-accelerating growth IS", () => {
  const flatThenSpike = [obs(1, 1, "x", 3, 30), obs(1, 1, "x", 3, 15), obs(1, 1, "x", 20, 0)];
  const cmp1 = compareWindow(flatThenSpike, "x", 30)!;
  assert.equal(isPersistent(flatThenSpike, cmp1), false);

  const accelerating = [obs(1, 1, "x", 8, 30), obs(1, 1, "x", 11, 15), obs(1, 1, "x", 48, 0)];
  const cmp2 = compareWindow(accelerating, "x", 30)!;
  assert.equal(isPersistent(accelerating, cmp2), true, "the rise had already begun at the middle reading (11 > 8), even though most growth is in the final interval");
});

// ---- the six required scenarios --------------------------------------------------------------------------------------

test("SCENARIO A — stable company: no signal at all", () => {
  const signals = deriveSignalsForCompany(SCENARIO_A_COMPANY_ID, SCENARIO_A);
  assert.deepEqual(signals, []);
});

test("SCENARIO B — hiring acceleration (jobs 2->5->14, sales 0->0->4): a surge and a sales-started signal fire, explained in plain English", () => {
  const signals = deriveSignalsForCompany(SCENARIO_B_COMPANY_ID, SCENARIO_B);
  const types = signals.map((s) => s.signal_type);
  assert.ok(types.includes("open_jobs_surge"), types.join(","));
  assert.ok(types.includes("sales_hiring_started"), types.join(","));
  const surge = signals.find((s) => s.signal_type === "open_jobs_surge")!;
  assert.equal(surge.from_value, 2);
  assert.equal(surge.to_value, 14);
  assert.match(surge.explanation, /open positions increased from 2 to 14/);
  assert.equal(surge.rule_version, "hiring-v1");
});

test("SCENARIO C — developer acceleration (commits 8->11->48, contributors 3->3->7, a release appears): GitHub signals fire, independently of hiring", () => {
  const signals = deriveSignalsForCompany(SCENARIO_C_COMPANY_ID, SCENARIO_C);
  const types = signals.map((s) => s.signal_type);
  assert.ok(types.includes("commit_activity_increase"), types.join(","));
  assert.ok(types.includes("contributor_growth"), types.join(","));
  assert.ok(types.includes("release_activity"), types.join(","));
  assert.ok(!types.includes("open_jobs_surge") && !types.includes("open_jobs_increase"), "no ATS data exists for this company, so no hiring signal should appear");
  assert.ok(signals.every((s) => s.family === "github"));
});

test("SCENARIO D — multi-family acceleration: hiring and GitHub each fire independently, family identity preserved", () => {
  const signals = deriveSignalsForCompany(SCENARIO_D_COMPANY_ID, SCENARIO_D);
  const families = new Set(signals.map((s) => s.family));
  assert.deepEqual([...families].sort(), ["github", "hiring"]);
  assert.ok(signals.some((s) => s.family === "hiring" && s.signal_type === "open_jobs_surge"));
  assert.ok(signals.some((s) => s.family === "github" && s.signal_type === "star_velocity_increase"));
});

test("SCENARIO E — noisy one-period spike that falls back: endpoint-only windowing ignores the mid-window peak entirely", () => {
  const signals = deriveSignalsForCompany(SCENARIO_E_COMPANY_ID, SCENARIO_E);
  assert.deepEqual(signals, [], "3 -> 4 (comparing only the two endpoints) is far below any threshold; the transient 20 in between is invisible to a window comparison, by design");
});

test("SCENARIO E2 — the spike IS the latest reading (no fall-back data yet): conservative behavior — no 'surge' claim, but the plain increase is still reported, not hidden", () => {
  const signals = deriveSignalsForCompany(SCENARIO_E2_COMPANY_ID, SCENARIO_E2);
  const types = signals.map((s) => s.signal_type);
  assert.ok(!types.includes("open_jobs_surge"), "must not overclaim persistence for a value that was flat until the very last reading");
  assert.ok(types.includes("open_jobs_increase"), "the increase itself is real and should still be visible, just not framed as a confirmed surge");
});

test("SCENARIO F — insufficient history (one observation only): no velocity signal, explicitly, not a guess", () => {
  const signals = deriveSignalsForCompany(SCENARIO_F_COMPANY_ID, SCENARIO_F);
  assert.deepEqual(signals, []);
});

// ---- explainability / traceability ------------------------------------------------------------------------------------

test("every derived signal traces back to real observation ids and is explainable from structured fields alone", () => {
  const signals = deriveSignalsForCompany(SCENARIO_D_COMPANY_ID, SCENARIO_D);
  assert.ok(signals.length > 0);
  for (const s of signals) {
    assert.ok(s.to_observation_id !== null, `${s.signal_type} must reference the observation it fired from`);
    assert.ok(s.explanation.length > 0 && !/undefined|NaN|null/.test(s.explanation), `${s.signal_type}: "${s.explanation}"`);
    assert.ok(s.rule_version.length > 0);
  }
});

test("metricSeries returns metric history sorted oldest-first, ignoring other metrics", () => {
  const series = metricSeries(SCENARIO_A, "github_stars");
  assert.deepEqual(series.map((o) => o.numeric_value), [100, 102, 103]);
});
