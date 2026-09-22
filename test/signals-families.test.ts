import assert from "node:assert/strict";
import { test } from "node:test";
import { activeFamiliesWithinWindow, areFamiliesClustered, summarizeFamilyActivity } from "../src/signals/families.ts";
import type { DerivedSignal } from "../src/signals/types.ts";

/**
 * V2-2B.1 — the multi-family FOUNDATION. The one rule every test here exists to prove: FIVE
 * signals from ONE family must never look like five independent families. No final score is
 * computed here (deliberately not built yet — see the V2-2B design report).
 */

function sig(overrides: Partial<DerivedSignal> = {}): DerivedSignal {
  return { id: 1, company_id: 1, family: "github", signal_type: "star_velocity_increase", window_days: 30, from_observation_id: 1, to_observation_id: 2, from_value: 1, to_value: 2, delta: 1, relative_change: 1, rule_version: "github-v1", explanation: "x", fired_at: "2026-09-22T00:00:00Z", metadata: null, ...overrides };
}

test("NON-NEGOTIABLE: five signals from ONE family count as exactly one active family, not five", () => {
  const signals = Array.from({ length: 5 }, (_, i) => sig({ id: i + 1, signal_type: `github_signal_${i}`, fired_at: "2026-09-22T00:00:00Z" }));
  const active = activeFamiliesWithinWindow(signals, 14, new Date("2026-09-22T12:00:00Z"));
  assert.deepEqual(active, ["github"]);
  assert.equal(areFamiliesClustered(signals, 14, new Date("2026-09-22T12:00:00Z")), false, "one family, however many signals, is never 'clustered' (which requires 2+ INDEPENDENT families)");
});

test("two signals from two DIFFERENT families within the window ARE clustered", () => {
  const signals = [sig({ id: 1, family: "github", fired_at: "2026-09-20T00:00:00Z" }), sig({ id: 2, family: "hiring", signal_type: "open_jobs_surge", fired_at: "2026-09-22T00:00:00Z" })];
  const now = new Date("2026-09-22T12:00:00Z");
  assert.deepEqual(activeFamiliesWithinWindow(signals, 14, now).sort(), ["github", "hiring"]);
  assert.equal(areFamiliesClustered(signals, 14, now), true);
});

test("a signal OUTSIDE the window does not count toward 'active families right now'", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const signals = [sig({ id: 1, family: "github", fired_at: "2026-01-01T00:00:00Z" })]; // long ago
  assert.deepEqual(activeFamiliesWithinWindow(signals, 14, now), []);
});

test("summarizeFamilyActivity: groups by family, reports distinct signal TYPE count (not raw count) alongside raw count, and first/last fired timestamps", () => {
  const signals = [
    sig({ id: 1, family: "github", signal_type: "star_velocity_increase", fired_at: "2026-09-01T00:00:00Z" }),
    sig({ id: 2, family: "github", signal_type: "star_velocity_increase", fired_at: "2026-09-10T00:00:00Z" }), // same type again
    sig({ id: 3, family: "github", signal_type: "contributor_growth", fired_at: "2026-09-15T00:00:00Z" }),
    sig({ id: 4, family: "hiring", signal_type: "open_jobs_surge", fired_at: "2026-09-05T00:00:00Z" }),
  ];
  const summary = summarizeFamilyActivity(signals);
  const github = summary.find((f) => f.family === "github")!;
  assert.equal(github.signalCount, 3);
  assert.equal(github.distinctSignalTypes, 2, "3 signals but only 2 DISTINCT types — a caller can tell 'repeated same signal' from 'genuinely varied activity'");
  assert.equal(github.firstFiredAt, "2026-09-01T00:00:00Z");
  assert.equal(github.lastFiredAt, "2026-09-15T00:00:00Z");
  const hiring = summary.find((f) => f.family === "hiring")!;
  assert.equal(hiring.signalCount, 1);
  assert.equal(hiring.distinctSignalTypes, 1);
});

test("a family with zero fired signals never appears in summarizeFamilyActivity — only families with at least one entry", () => {
  assert.deepEqual(summarizeFamilyActivity([]), []);
});

test("level signals (V2-2B.1) and velocity signals from the SAME family are still just one family in the summary — the mechanism (level vs velocity) doesn't create a second family", () => {
  const signals = [
    sig({ id: 1, family: "hiring", signal_type: "high_hiring_present_at_first_observation", rule_version: "hiring-level-v1", window_days: 0, from_observation_id: null }),
    sig({ id: 2, family: "hiring", signal_type: "open_jobs_surge", rule_version: "hiring-v1" }),
  ];
  const now = new Date("2026-09-22T12:00:00Z");
  assert.deepEqual(activeFamiliesWithinWindow(signals, 14, now), ["hiring"]);
});
