import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveGithubLevelSignals } from "../src/signals/rules/github.ts";
import { deriveHiringLevelSignals } from "../src/signals/rules/hiring.ts";
import { GITHUB_LEVEL_THRESHOLDS, HIRING_LEVEL_THRESHOLDS } from "../src/signals/rules/thresholds.ts";
import { deriveSignalsForCompany } from "../src/signals/observe.ts";
import type { Observation } from "../src/signals/types.ts";

/**
 * V2-2B.1 — the direct regression suite for the cold-start defect: before this milestone, a
 * company's FIRST-EVER observation of any metric could never produce a signal (every rule required
 * bestAvailableWindow, which needs 2+ observations). These tests prove that's fixed, without
 * weakening the "unknown != zero" discipline signals-missing-vs-zero.test.ts already established.
 */

let nextId = 1;
function obs(overrides: Partial<Observation> & Pick<Observation, "metric_name">): Observation {
  return {
    id: nextId++, company_id: 1, signal_source_id: 1, numeric_value: null, text_value: null,
    observed_at: "2026-09-22T00:00:00Z", source_timestamp: null, collection_version: "test-v1", raw_payload_ref: null,
    ...overrides,
  };
}

// ---- 1. first observation CAN fire a legitimate level signal --------------------------------------------------------

test("hiring level: a first-ever observation with unusually high open jobs fires high_hiring_present_at_first_observation", () => {
  const history = [obs({ metric_name: "ats_open_jobs_total", numeric_value: 12 })];
  const signals = deriveHiringLevelSignals(1, history);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.signal_type, "high_hiring_present_at_first_observation");
  assert.equal(signals[0]!.family, "hiring");
});

test("hiring level: meaningful sales/recruiting/security roles present at first observation each fire their own signal", () => {
  const history = [
    obs({ metric_name: "ats_open_jobs_sales", numeric_value: 3 }),
    obs({ metric_name: "ats_has_recruiting_role", numeric_value: 1 }),
    obs({ metric_name: "ats_has_security_compliance_role", numeric_value: 1 }),
  ];
  const signals = deriveHiringLevelSignals(1, history);
  const types = signals.map((s) => s.signal_type).sort();
  assert.deepEqual(types, ["recruiting_role_present_at_first_observation", "sales_hiring_present_at_first_observation", "security_compliance_role_present_at_first_observation"]);
});

test("github level: a first-ever observation with high commit activity, contributor count, and a recent release all fire", () => {
  const history = [
    obs({ metric_name: "github_commits_last_4w", numeric_value: 40 }),
    obs({ metric_name: "github_contributors", numeric_value: 9 }),
    obs({ metric_name: "github_latest_release_at", text_value: "2026-09-18T00:00:00Z" }),
  ];
  const now = new Date("2026-09-22T00:00:00Z");
  const signals = deriveGithubLevelSignals(1, history, now);
  const types = signals.map((s) => s.signal_type).sort();
  assert.deepEqual(types, ["active_development_present_at_first_observation", "meaningful_contributor_count_at_first_observation", "recent_release_present_at_first_observation"]);
});

test("brief's own worked example — Company B: 10 open roles, first sales hiring, active GitHub, all on day one — fires multiple level signals immediately, zero velocity history required", () => {
  const history = [
    obs({ metric_name: "ats_open_jobs_total", numeric_value: 10, signal_source_id: 1 }),
    obs({ metric_name: "ats_open_jobs_sales", numeric_value: 2, signal_source_id: 1 }),
    obs({ metric_name: "github_commits_last_4w", numeric_value: 25, signal_source_id: 2 }),
  ];
  const derived = deriveSignalsForCompany(1, history, new Date("2026-09-22T00:00:00Z"));
  assert.ok(derived.length >= 3, `expected several signals from a single strong first observation, got ${derived.length}`);
  assert.ok(derived.every((s) => s.window_days === 0 && s.from_observation_id === null), "every fired signal here is level-only: no comparison window, no 'from'");
});

// ---- 2. first observation CANNOT fire a false velocity signal (regression: existing SCENARIO F) -----------------------

test("a first-ever observation NEVER fires a velocity signal, only level signals — the two rule categories are additive, not substitutable", () => {
  const history = [obs({ metric_name: "ats_open_jobs_total", numeric_value: 12 })];
  const derived = deriveSignalsForCompany(1, history, new Date());
  assert.ok(derived.every((s) => s.rule_version.includes("level")), "no non-level (velocity) signal should be able to fire from one observation");
});

// ---- 3. high first observation does NOT imply prior zero / claim a transition -----------------------------------------

test("a level signal never claims from_value or a delta — nothing is asserted about what came before", () => {
  const history = [obs({ metric_name: "ats_open_jobs_total", numeric_value: 15 })];
  const [signal] = deriveHiringLevelSignals(1, history);
  assert.equal(signal!.from_value, null);
  assert.equal(signal!.delta, null);
  assert.equal(signal!.relative_change, null);
  assert.equal(signal!.from_observation_id, null);
});

// ---- 4. "present" language vs "started" language ------------------------------------------------------------------

test("level-signal wording uses 'present at first observation' / 'observed at first look' — never 'started'/'appeared'/'increased'/'grew'", () => {
  const history = [
    obs({ metric_name: "ats_open_jobs_total", numeric_value: 20 }),
    obs({ metric_name: "ats_open_jobs_sales", numeric_value: 4 }),
    obs({ metric_name: "ats_has_enterprise_sales_role", numeric_value: 1 }),
    obs({ metric_name: "github_commits_last_4w", numeric_value: 30, signal_source_id: 2 }),
    obs({ metric_name: "github_contributors", numeric_value: 8, signal_source_id: 2 }),
  ];
  const derived = [...deriveHiringLevelSignals(1, history), ...deriveGithubLevelSignals(1, history, new Date("2026-09-22T00:00:00Z"))];
  assert.ok(derived.length >= 5);
  const banned = /\b(started|appeared|increased|grew)\b/i;
  for (const s of derived) {
    assert.doesNotMatch(s.explanation, banned, `signal_type "${s.signal_type}" explanation claims a transition it has no evidence for: "${s.explanation}"`);
    assert.match(s.explanation, /present at first observation|observed at first look/i, `signal_type "${s.signal_type}" should describe current state only: "${s.explanation}"`);
  }
});

test("the existing VELOCITY 'started' signal wording is untouched — it legitimately HAS a prior-zero observation to compare against", () => {
  // Regression guard: the language rule applies to LEVEL signals (no history), not to velocity
  // signals that genuinely observed a 0 -> nonzero transition — those may still say "started".
  const history = [
    obs({ metric_name: "ats_open_jobs_sales", numeric_value: 0, observed_at: "2026-08-01T00:00:00Z" }),
    obs({ metric_name: "ats_open_jobs_sales", numeric_value: 3, observed_at: "2026-09-22T00:00:00Z" }),
  ];
  const derived = deriveSignalsForCompany(1, history, new Date("2026-09-22T00:00:00Z"));
  const started = derived.find((s) => s.signal_type === "sales_hiring_started");
  assert.ok(started, "the existing velocity 0->nonzero rule must still fire and still use 'started' wording");
  assert.match(started!.explanation, /appeared/i);
});

// ---- 5. level-signal thresholds are deliberately more conservative than velocity thresholds ----------------------------

test("level thresholds are documented as MORE conservative than their velocity counterparts", () => {
  assert.ok(HIRING_LEVEL_THRESHOLDS.openJobsHighAtFirstObservation > 3, "well above the velocity 'increase' delta of 3");
  assert.ok(GITHUB_LEVEL_THRESHOLDS.activeCommitsAtFirstObservation === 20, "2x the velocity quiet_to_active floor of 10");
});

test("hiring level: just below the open-jobs threshold does not fire; at the threshold it does (boundary check)", () => {
  const below = [obs({ metric_name: "ats_open_jobs_total", numeric_value: HIRING_LEVEL_THRESHOLDS.openJobsHighAtFirstObservation - 1 })];
  const at = [obs({ metric_name: "ats_open_jobs_total", numeric_value: HIRING_LEVEL_THRESHOLDS.openJobsHighAtFirstObservation })];
  assert.equal(deriveHiringLevelSignals(1, below).length, 0);
  assert.equal(deriveHiringLevelSignals(1, at).length, 1);
});

test("github level: a release older than the recency window does not fire; one within it does (boundary check)", () => {
  const now = new Date("2026-09-22T00:00:00Z");
  const tooOld = [obs({ metric_name: "github_latest_release_at", text_value: new Date(now.getTime() - (GITHUB_LEVEL_THRESHOLDS.recentReleaseMaxAgeDays + 1) * 86_400_000).toISOString() })];
  const recent = [obs({ metric_name: "github_latest_release_at", text_value: new Date(now.getTime() - (GITHUB_LEVEL_THRESHOLDS.recentReleaseMaxAgeDays - 1) * 86_400_000).toISOString() })];
  assert.equal(deriveGithubLevelSignals(1, tooOld, now).length, 0);
  assert.equal(deriveGithubLevelSignals(1, recent, now).length, 1);
});

// ---- 6. once a SECOND observation exists, the level signal never fires again (no daily re-firing for a stable-high baseline) --

test("a company with a permanently-high metric only fires the level signal ONCE — from the second observation on, velocity rules take over, not a repeated level signal", () => {
  const history = [
    obs({ metric_name: "ats_open_jobs_total", numeric_value: 40, observed_at: "2026-08-01T00:00:00Z" }),
    obs({ metric_name: "ats_open_jobs_total", numeric_value: 41, observed_at: "2026-09-22T00:00:00Z" }),
  ];
  const levelSignals = deriveHiringLevelSignals(1, history);
  assert.equal(levelSignals.length, 0, "with 2 observations for this metric, metricSeries(...).length is 2, not 1 — the level gate must not fire");
});

// ---- 7. multi-family: level signals from different families fire independently, family identity preserved -----------

test("level signals preserve family identity exactly like velocity signals already do", () => {
  const history = [
    obs({ metric_name: "ats_open_jobs_total", numeric_value: 15, signal_source_id: 1 }),
    obs({ metric_name: "github_commits_last_4w", numeric_value: 25, signal_source_id: 2 }),
  ];
  const derived = deriveSignalsForCompany(1, history, new Date("2026-09-22T00:00:00Z"));
  assert.ok(derived.some((s) => s.family === "hiring"));
  assert.ok(derived.some((s) => s.family === "github"));
});
