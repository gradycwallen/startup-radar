import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computeCoverage } from "../src/signals/coverage.ts";
import type { DerivedSignal, Observation, SignalSource } from "../src/signals/types.ts";

/**
 * V2-2B.1 — Coverage: a DERIVED, read-time description of how much evidence exists. The
 * non-negotiable this whole file exists to prove: Coverage NEVER feeds into signal strength or
 * momentum — it is reporting context only.
 */

function source(overrides: Partial<SignalSource> = {}): SignalSource {
  return { id: 1, company_id: 1, source_type: "github_repo", external_id: "acme/widget", canonical_url: null, resolution_method: "homepage_link_confirmed", resolution_confidence: 0.95, resolution_evidence: "x", active: true, metadata: null, ...overrides };
}
function observation(overrides: Partial<Observation> = {}): Observation {
  return { id: 1, company_id: 1, signal_source_id: 1, metric_name: "github_stars", numeric_value: 5, text_value: null, observed_at: "2026-09-22T00:00:00Z", source_timestamp: null, collection_version: "github-v1", raw_payload_ref: null, ...overrides };
}
function signal(overrides: Partial<DerivedSignal> = {}): DerivedSignal {
  return { id: 1, company_id: 1, family: "github", signal_type: "star_velocity_increase", window_days: 30, from_observation_id: 1, to_observation_id: 2, from_value: 1, to_value: 2, delta: 1, relative_change: 1, rule_version: "github-v1", explanation: "x", fired_at: "2026-09-22T00:00:00Z", metadata: null, ...overrides };
}

test("a company with zero sources/observations/signals gets an honest 'nothing here yet' descriptor, not an error", () => {
  const c = computeCoverage([], [], []);
  assert.deepEqual(c.familiesResolved, []);
  assert.deepEqual(c.familiesObserved, []);
  assert.deepEqual(c.activeSignalFamilies, []);
  assert.equal(c.firstObservedAt, null);
  assert.equal(c.lastObservedAt, null);
  assert.equal(c.observationSpanDays, null);
  assert.equal(c.observationCount, 0);
  assert.equal(c.historyClass, "early_evidence");
});

test("familiesResolved reflects ACTIVE sources only, mapped by source_type -> family (github_repo/github_org -> github; greenhouse/lever/ashby -> hiring)", () => {
  const sources = [
    source({ id: 1, source_type: "github_repo" }),
    source({ id: 2, source_type: "greenhouse", active: false }), // inactive — must not count
  ];
  const c = computeCoverage(sources, [], []);
  assert.deepEqual(c.familiesResolved, ["github"]);
});

test("familiesObserved can be a SUBSET of familiesResolved — a source resolved this same pass with no collection yet", () => {
  const sources = [source({ id: 1, source_type: "github_repo" }), source({ id: 2, source_type: "greenhouse", active: true })];
  const observations = [observation({ signal_source_id: 1 })]; // only the github source has ever been observed
  const c = computeCoverage(sources, observations, []);
  assert.deepEqual(c.familiesResolved.sort(), ["github", "hiring"]);
  assert.deepEqual(c.familiesObserved, ["github"]);
});

test("activeSignalFamilies reflects FIRED signals, distinct from merely having observations — 'we have data' != 'something notable happened'", () => {
  const sources = [source()];
  const observations = [observation()];
  const c = computeCoverage(sources, observations, []); // no signals fired
  assert.deepEqual(c.familiesObserved, ["github"]);
  assert.deepEqual(c.activeSignalFamilies, [], "no signal fired yet, so no family should read as 'active'");
});

test("firstObservedAt/lastObservedAt/observationSpanDays use RAW observed_at — collection history, not source_timestamp-adjusted fact history", () => {
  // A backfilled row claims a fact from 60 days ago (source_timestamp), but was actually WRITTEN
  // (observed_at) only moments ago, alongside a live point from the same run.
  const observations = [
    observation({ id: 1, observed_at: "2026-09-22T10:00:00Z", source_timestamp: "2026-07-24T00:00:00Z", collection_version: "github-v1-backfill" }),
    observation({ id: 2, observed_at: "2026-09-22T10:00:00Z", source_timestamp: null, collection_version: "github-v1" }),
  ];
  const c = computeCoverage([source()], observations, []);
  assert.equal(c.observationSpanDays, 0, "span must reflect real COLLECTION history (same moment), not the 60-day source_timestamp spread — otherwise Coverage would claim long history the instant a backfill runs");
});

test("historyClass: early_evidence when there's one observation or none; developing_history once real span exists but is short; longitudinal_history once span clears the threshold", () => {
  const one = computeCoverage([source()], [observation({ id: 1 })], []);
  assert.equal(one.historyClass, "early_evidence");

  const shortSpan = computeCoverage(
    [source()],
    [observation({ id: 1, observed_at: "2026-09-01T00:00:00Z" }), observation({ id: 2, observed_at: "2026-09-10T00:00:00Z" })],
    [],
  );
  assert.equal(shortSpan.historyClass, "developing_history");

  const longSpan = computeCoverage(
    [source()],
    [observation({ id: 1, observed_at: "2026-06-01T00:00:00Z" }), observation({ id: 2, observed_at: "2026-09-22T00:00:00Z" })],
    [],
  );
  assert.equal(longSpan.historyClass, "longitudinal_history");
});

test("NON-NEGOTIABLE: observation count alone does not change historyClass unless real span also grows — ten observations packed into one collection run stay early_evidence", () => {
  const observations = Array.from({ length: 10 }, (_, i) => observation({ id: i + 1, observed_at: "2026-09-22T10:00:00Z", metric_name: `metric_${i}` }));
  const c = computeCoverage([source()], observations, []);
  assert.equal(c.observationCount, 10);
  assert.equal(c.historyClass, "early_evidence", "ten observations from the SAME moment must not read as more history than one observation would");
});

test("NON-NEGOTIABLE: number of resolved families alone does not change historyClass — many families resolved in the same first pass stay early_evidence", () => {
  const sources = [source({ id: 1, source_type: "github_repo" }), source({ id: 2, source_type: "greenhouse" })];
  const observations = [observation({ signal_source_id: 1, observed_at: "2026-09-22T10:00:00Z" }), observation({ signal_source_id: 2, observed_at: "2026-09-22T10:00:01Z", metric_name: "ats_open_jobs_total" })];
  const c = computeCoverage(sources, observations, []);
  assert.deepEqual(c.familiesResolved.sort(), ["github", "hiring"]);
  assert.equal(c.historyClass, "early_evidence");
});

// ---- structural guard: Coverage/family modules must never be imported by signal-derivation code ------------------------

test("STRUCTURAL GUARD: no rules/*.ts or observe.ts file imports coverage.ts or families.ts — Coverage/multi-family summaries must never influence what a signal derivation function returns", () => {
  const files = [
    "src/signals/observe.ts",
    "src/signals/rules/hiring.ts",
    "src/signals/rules/github.ts",
    "src/signals/rules/format.ts",
    "src/signals/velocity.ts",
    "src/signals/dedup.ts",
  ];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.ok(!content.includes("coverage.ts") && !content.includes("from \"./coverage") && !content.includes("from \"../coverage"), `${file} must never import coverage.ts`);
    assert.ok(!content.includes("families.ts") && !content.includes("from \"./families") && !content.includes("from \"../families"), `${file} must never import families.ts`);
  }
});
