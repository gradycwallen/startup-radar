import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverageLine, buildSignalViewModels, SIGNAL_EMPTY_STATE_COPY } from "../src/lib/derive/signal-view-model.ts";
import type { DerivedSignal, SignalIntelligence, SignalObservation, SignalSource } from "../src/lib/data/types.ts";

/**
 * V2-3A — pure-function tests for the Signal Intelligence presentation layer. No React, no
 * Supabase, no server — every case here is "given these raw rows, does the view model say the
 * right (and never a misleading) thing." Run via `node --test` directly (Node 24's native
 * TypeScript support) — no test framework dependency was added; see the delivery report.
 */

let nextId = 1;
function source(overrides: Partial<SignalSource> = {}): SignalSource {
  return { id: nextId++, companyId: 1, sourceType: "website", externalId: "acme.com", canonicalUrl: "https://acme.com/", resolutionMethod: "company_domain", active: true, ...overrides };
}
function observation(overrides: Partial<SignalObservation> = {}): SignalObservation {
  return { id: nextId++, companyId: 1, signalSourceId: 1, metricName: "website_fetch_outcome", numericValue: null, textValue: null, observedAt: "2026-09-22T12:00:00Z", collectionVersion: "website-v1", metadata: null, ...overrides };
}
function signal(overrides: Partial<DerivedSignal> = {}): DerivedSignal {
  return {
    id: nextId++, companyId: 1, family: "website", signalType: "website_commercial_footprint_present_at_first_observation", windowDays: 0,
    fromObservationId: null, toObservationId: null, fromValue: null, toValue: null, delta: null, relativeChange: null,
    explanation: "test explanation", firedAt: "2026-09-22T12:00:00Z", metadata: null, ...overrides,
  };
}
function intelligence(overrides: Partial<SignalIntelligence> = {}): SignalIntelligence {
  return { sources: [], observations: [], signals: [], ...overrides };
}

// ---- zero signals ------------------------------------------------------------------------------------------

test("zero signals: buildSignalViewModels returns an empty array, never throws", () => {
  assert.deepEqual(buildSignalViewModels(intelligence()), []);
});

test("zero sources: coverage line is null (handled by the empty-state copy instead)", () => {
  assert.equal(buildCoverageLine(intelligence()), null);
});

test("sources exist, zero signals: coverage line is exactly 'Tracking started'", () => {
  assert.equal(buildCoverageLine(intelligence({ sources: [source()] })), "Tracking started");
});

// ---- first-look signal ---------------------------------------------------------------------------------------

test("regression: 'meaningful_contributor_count_at_first_observation' (the one real level signal_type with no 'present' in its name) still classifies as first_look", () => {
  const s = signal({ signalType: "meaningful_contributor_count_at_first_observation", family: "github" });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s] }));
  assert.equal(vm!.kind, "first_look");
  assert.equal(vm!.title, "Meaningful contributor activity detected");
});

test("first-look signal: classified as first_look, title describes a state, never a verb of change", () => {
  const s = signal({ signalType: "active_development_present_at_first_observation", family: "github", toObservationId: 99 });
  const obs = observation({ id: 99, metricName: "github_commits_last_4w", numericValue: 385 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [obs] }));
  assert.equal(vm!.kind, "first_look");
  assert.equal(vm!.title, "Active development detected");
});

test("first-look wording NEVER implies change — no signal_type's title contains a change verb", () => {
  const FIRST_LOOK_TYPES = [
    "high_hiring_present_at_first_observation", "sales_hiring_present_at_first_observation", "enterprise_sales_role_present_at_first_observation",
    "recruiting_role_present_at_first_observation", "security_compliance_role_present_at_first_observation",
    "active_development_present_at_first_observation", "meaningful_contributor_count_at_first_observation", "recent_release_present_at_first_observation",
    "website_commercial_footprint_present_at_first_observation",
  ];
  const signals = FIRST_LOOK_TYPES.map((signalType) => signal({ signalType }));
  const vms = buildSignalViewModels(intelligence({ signals }));
  assert.equal(vms.length, FIRST_LOOK_TYPES.length);
  for (const vm of vms) {
    assert.equal(vm.kind, "first_look");
    assert.doesNotMatch(vm.title, /appear|increase|start|surge|\bnew\b|grew|rose|↑/i, `first-look title "${vm.title}" must never imply change`);
  }
});

// ---- multiple signals across families -----------------------------------------------------------------------

test("multiple signals across families: each gets its own family label, sorted newest-fired first", () => {
  const signals = [
    signal({ family: "github", signalType: "active_development_present_at_first_observation", firedAt: "2026-09-20T00:00:00Z" }),
    signal({ family: "hiring", signalType: "open_jobs_surge", firedAt: "2026-09-22T00:00:00Z", fromValue: 4, toValue: 14, windowDays: 30, relativeChange: 2.5 }),
    signal({ family: "website", signalType: "website_pricing_page_appeared", firedAt: "2026-09-21T00:00:00Z" }),
  ];
  const vms = buildSignalViewModels(intelligence({ signals }));
  assert.deepEqual(vms.map((v) => v.familyLabel), ["Hiring", "Website", "GitHub"]); // newest-first order
});

// ---- transition evidence ----------------------------------------------------------------------------------

test("transition evidence: a numeric hiring signal shows from -> to, window, and percent change", () => {
  const s = signal({ family: "hiring", signalType: "open_jobs_surge", fromValue: 4, toValue: 14, windowDays: 30, relativeChange: 2.5, toObservationId: 5 });
  const obs = observation({ id: 5, metricName: "ats_open_jobs_total", numericValue: 14 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [obs] }));
  assert.deepEqual(vm!.evidence, [
    { label: "Open positions", value: "4 → 14" },
    { label: "Window", value: "30 days" },
    { label: "Change", value: "+250%" },
  ]);
});

// ---- numeric evidence completeness fix (regression: a first-look signal's evidence disclosure was
// previously empty of its own numeric value, since buildEvidence required BOTH from_value and
// to_value) -----------------------------------------------------------------------------------------

test("evidence completeness: a first-look signal with ONLY to_value shows a single 'observed' row, never a fabricated comparison", () => {
  const s = signal({ family: "github", signalType: "active_development_present_at_first_observation", fromValue: null, toValue: 385, toObservationId: 40 });
  const obs = observation({ id: 40, metricName: "github_commits_last_4w", numericValue: 385 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [obs] }));
  assert.deepEqual(vm!.evidence, [{ label: "Commits observed", value: "385" }]);
  assert.doesNotMatch(vm!.evidence[0]!.value, /→/, "a single first-look value must never render as an arrow comparison");
});

test("evidence completeness: a first-look signal uses the natural metric label (e.g. 'Contributors observed'), not a generic placeholder, when the metric is known", () => {
  const s = signal({ family: "github", signalType: "meaningful_contributor_count_at_first_observation", fromValue: null, toValue: 6, toObservationId: 41 });
  const obs = observation({ id: 41, metricName: "github_contributors", numericValue: 6 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [obs] }));
  assert.deepEqual(vm!.evidence, [{ label: "Contributors observed", value: "6" }]);
});

test("evidence completeness: a first-look signal for an UNRECOGNIZED metric still shows its value, under a generic honest label", () => {
  const s = signal({ family: "sec", signalType: "sec_filing_activity_present_at_first_observation", fromValue: null, toValue: 3, toObservationId: 42 });
  const obs = observation({ id: 42, metricName: "sec_forms_d_last_90d", numericValue: 3 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [obs] }));
  assert.deepEqual(vm!.evidence, [{ label: "Observed value", value: "3" }]);
});

test("evidence completeness: a REAL comparison (both from_value and to_value) still renders the existing arrow form, unaffected by this fix", () => {
  const s = signal({ family: "github", signalType: "commit_activity_increase", fromValue: 12, toValue: 69, windowDays: 30, toObservationId: 43 });
  const obs = observation({ id: 43, metricName: "github_commits_last_4w", numericValue: 69 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [obs] }));
  assert.deepEqual(vm!.evidence[0], { label: "Commits (trailing 4 weeks)", value: "12 → 69" });
});

test("evidence completeness: neither from_value nor to_value present renders no numeric evidence row at all (falls through to whatever else applies, never a fabricated one)", () => {
  const s = signal({ family: "hiring", fromValue: null, toValue: null, toObservationId: 44 });
  const obs = observation({ id: 44, metricName: "ats_open_jobs_total", numericValue: null, textValue: null });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [obs] }));
  assert.deepEqual(vm!.evidence, []);
});

test("evidence completeness: an unknown prior value is NEVER rendered as zero — a first-look value never implies '0 -> N'", () => {
  const s = signal({ family: "github", signalType: "active_development_present_at_first_observation", fromValue: null, toValue: 40, toObservationId: 45 });
  const obs = observation({ id: 45, metricName: "github_commits_last_4w", numericValue: 40 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [obs] }));
  assert.deepEqual(vm!.evidence, [{ label: "Commits observed", value: "40" }]);
  assert.ok(!vm!.evidence.some((e) => e.value.includes("0 →")), "no evidence row may read as if a prior value of 0 was observed");
});

test("transition evidence: a website page appearance builds a 3-step progression from real observation rows", () => {
  const fromObs = observation({ id: 10, signalSourceId: 1, metricName: "website_page_pricing", numericValue: 0, observedAt: "2026-09-22T00:00:00Z" });
  const middleObs = observation({ id: 11, signalSourceId: 1, metricName: "website_page_pricing", numericValue: 1, observedAt: "2026-09-29T00:00:00Z" });
  const toObs = observation({ id: 12, signalSourceId: 1, metricName: "website_page_pricing", numericValue: 1, observedAt: "2026-10-06T00:00:00Z", textValue: "/pricing", metadata: { final_url: "https://acme.com/pricing" } });
  const s = signal({ family: "website", signalType: "website_pricing_page_appeared", fromObservationId: 10, toObservationId: 12, fromValue: 0, toValue: 1 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [fromObs, middleObs, toObs] }));
  assert.deepEqual(vm!.progression, [
    { label: "Confirmed absent", date: "2026-09-22T00:00:00Z" },
    { label: "First observed", date: "2026-09-29T00:00:00Z" },
    { label: "Confirmed", date: "2026-10-06T00:00:00Z" },
  ]);
  assert.deepEqual(vm!.sourceLinks, [{ label: "View page", url: "https://acme.com/pricing" }]);
});

test("transition evidence: when no middle reading exists, progression is a 2-step list, never fabricated", () => {
  const fromObs = observation({ id: 20, signalSourceId: 1, metricName: "website_page_security", numericValue: 0, observedAt: "2026-09-22T00:00:00Z" });
  const toObs = observation({ id: 21, signalSourceId: 1, metricName: "website_page_security", numericValue: 1, observedAt: "2026-09-30T00:00:00Z" });
  const s = signal({ family: "website", signalType: "website_security_page_appeared", fromObservationId: 20, toObservationId: 21, fromValue: 0, toValue: 1 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [fromObs, toObs] }));
  assert.deepEqual(vm!.progression, [
    { label: "Confirmed absent", date: "2026-09-22T00:00:00Z" },
    { label: "Confirmed", date: "2026-09-30T00:00:00Z" },
  ]);
});

test("non-website transitions never get a progression (that shape only fits website's absent/present semantics)", () => {
  const s = signal({ family: "hiring", signalType: "open_jobs_increase", fromValue: 2, toValue: 6, fromObservationId: 1, toObservationId: 2 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [observation({ id: 1 }), observation({ id: 2 })] }));
  assert.deepEqual(vm!.progression, []);
});

// ---- multiple website signals remain one family --------------------------------------------------------------

test("multiple website signals: each gets familyLabel 'Website' — the ONE-family rule is a families.ts/derive.ts concern, not lost at this layer", () => {
  const signals = ["website_pricing_page_appeared", "website_enterprise_page_appeared", "website_customer_proof_appeared"].map((signalType) => signal({ family: "website", signalType }));
  const vms = buildSignalViewModels(intelligence({ signals }));
  assert.equal(vms.length, 3);
  assert.ok(vms.every((v) => v.familyLabel === "Website"));
  // The coverage line counts DISTINCT families, not signal count — 3 website signals still read as 1 family.
  const cov = buildCoverageLine(intelligence({ sources: [source()], signals, observations: signals.map((_, i) => observation({ id: 500 + i })) }));
  assert.match(cov!, /1 signal family observed$/);
});

// ---- tier -----------------------------------------------------------------------------------------------------

test("tier: read from signal.metadata.tier when present ('high'/'low'), null otherwise", () => {
  const high = signal({ metadata: { tier: "high" } });
  const low = signal({ metadata: { tier: "low" } });
  const none = signal({ metadata: null });
  const garbage = signal({ metadata: { tier: 42 } as unknown as Record<string, unknown> });
  const [vHigh, vLow, vNone, vGarbage] = buildSignalViewModels(intelligence({ signals: [high, low, none, garbage] }));
  assert.equal(vHigh!.tier, "high");
  assert.equal(vLow!.tier, "low");
  assert.equal(vNone!.tier, null);
  assert.equal(vGarbage!.tier, null, "a malformed tier value must never crash or be trusted as-is");
});

// ---- sparse / malformed metadata -----------------------------------------------------------------------------

test("sparse metadata: a signal with null metadata and no resolvable observations still produces a valid, safe view model", () => {
  const s = signal({ fromObservationId: 999, toObservationId: 998, metadata: null }); // ids that don't resolve to anything
  const [vm] = buildSignalViewModels(intelligence({ signals: [s] }));
  assert.equal(vm!.tier, null);
  assert.deepEqual(vm!.evidence, []);
  assert.deepEqual(vm!.progression, []);
  assert.deepEqual(vm!.sourceLinks, []);
});

test("malformed optional metadata (pages_present is not an array) fails gracefully, never throws", () => {
  const s = signal({ metadata: { pages_present: "not-an-array" } as unknown as Record<string, unknown> });
  assert.doesNotThrow(() => buildSignalViewModels(intelligence({ signals: [s] })));
  const [vm] = buildSignalViewModels(intelligence({ signals: [s] }));
  assert.deepEqual(vm!.evidence, []);
});

test("malformed final_url in observation metadata (not a real https URL) is never surfaced as a link", () => {
  const toObs = observation({ id: 30, metadata: { final_url: "javascript:alert(1)" } });
  const s = signal({ toObservationId: 30 });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], observations: [toObs] }));
  assert.deepEqual(vm!.sourceLinks, []);
});

// ---- unknown future signal_type ------------------------------------------------------------------------------

test("unknown future signal_type: humanized fallback title, correct kind classification, never throws, never hidden", () => {
  const s = signal({ signalType: "sec_form_d_filed", family: "sec" });
  const vms = buildSignalViewModels(intelligence({ signals: [s] }));
  assert.equal(vms.length, 1, "an unrecognized signal must still be included, never silently dropped");
  assert.equal(vms[0]!.title, "Sec form d filed");
  assert.equal(vms[0]!.kind, "transition");
  assert.equal(vms[0]!.familyLabel, "Sec", "an unrecognized family falls back to a humanized (capitalized) raw string, not a crash, and stays visually consistent with Hiring/GitHub/Website");
});

test("unknown future FIRST-LOOK signal_type is still correctly classified via the naming suffix, with no lookup entry needed", () => {
  const s = signal({ signalType: "sec_filing_activity_present_at_first_observation", family: "sec" });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s] }));
  assert.equal(vm!.kind, "first_look");
  assert.equal(vm!.title, "Sec filing activity present at first observation");
});

// ---- missing source / evidence never reads as negative --------------------------------------------------------

test("missing source link (no matching signal_sources row) simply omits the link — never an error, never negative copy", () => {
  const s = signal({ family: "github" });
  const [vm] = buildSignalViewModels(intelligence({ signals: [s], sources: [] }));
  assert.deepEqual(vm!.sourceLinks, []);
});

test("the shared empty-state copy never uses negative words like 'missing'/'failed'/'none'/'absent' where absence isn't confirmed", () => {
  const negativeWords = /\b(missing|failed|none|absent|unavailable|error)\b/i;
  assert.doesNotMatch(SIGNAL_EMPTY_STATE_COPY.noSources, negativeWords);
  assert.doesNotMatch(SIGNAL_EMPTY_STATE_COPY.noSignalsYet, negativeWords);
  assert.doesNotMatch(SIGNAL_EMPTY_STATE_COPY.notYetDetermined, negativeWords);
});

// ---- coverage: history-class thresholds ------------------------------------------------------------------------

test("coverage: a >=1 day observation span with signals fired is 'Developing history'", () => {
  const obs = [observation({ observedAt: "2026-09-01T00:00:00Z" }), observation({ observedAt: "2026-09-10T00:00:00Z" })];
  const cov = buildCoverageLine(intelligence({ sources: [source()], observations: obs, signals: [signal()] }));
  assert.match(cov!, /^Developing history · Tracked for 9 days/);
});

test("coverage: a >=30 day observation span is 'Longitudinal history'", () => {
  const obs = [observation({ observedAt: "2026-08-01T00:00:00Z" }), observation({ observedAt: "2026-09-22T00:00:00Z" })];
  const cov = buildCoverageLine(intelligence({ sources: [source()], observations: obs, signals: [signal()] }));
  assert.match(cov!, /^Longitudinal history · Tracked for \d+ days/);
});

test("coverage: never shows a raw observation count, a percentage, or a score-shaped number", () => {
  const obs = Array.from({ length: 40 }, (_, i) => observation({ observedAt: `2026-09-${String((i % 20) + 1).padStart(2, "0")}T00:00:00Z` }));
  const cov = buildCoverageLine(intelligence({ sources: [source()], observations: obs, signals: [signal()] }));
  assert.doesNotMatch(cov!, /%/);
  assert.doesNotMatch(cov!, /\b40\b/, "the raw observation count (40) must never leak into the coverage line");
});
