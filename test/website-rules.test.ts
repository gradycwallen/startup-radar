import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveWebsiteLevelSignals, deriveWebsiteTransitionSignals } from "../src/signals/rules/website.ts";
import { deriveSignalsForCompany } from "../src/signals/observe.ts";
import { summarizeFamilyActivity, activeFamiliesWithinWindow } from "../src/signals/families.ts";
import type { Observation } from "../src/signals/types.ts";

/**
 * V2-2B.2 — rules/website.ts. Covers the design report's cases B/C/I (which need a second
 * observation and/or the derived rules, unlike test/website-resolve.test.ts's collector-only
 * cases). All fixtures build raw `Observation[]` rows directly (mirroring how
 * sources/website.ts's collector actually writes them — one row per known metric, `numeric_value`
 * 1/0 only, never a row for "unknown").
 */

let nextId = 1;
function obs(metric: string, hoursAgo: number, value: number | null, overrides: Partial<Observation> = {}): Observation {
  return {
    id: nextId++, company_id: 1, signal_source_id: 1, metric_name: metric, numeric_value: value, text_value: overrides.text_value ?? null,
    observed_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), source_timestamp: null, collection_version: "website-v1", raw_payload_ref: null, metadata: null,
    ...overrides,
  };
}
/** One full pass's worth of rows sharing the SAME observed_at — matches how one real
 * `runWebsitePass` call writes all its metrics (see observe.ts's `toObservations`). */
function pass(hoursAgo: number, outcome: string, pages: Partial<Record<string, 0 | 1>>, prelaunch?: 0 | 1, collectionVersion = "website-v1"): Observation[] {
  const ts = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const row = (metric: string, value: number | null, textValue: string | null = null): Observation => ({
    id: nextId++, company_id: 1, signal_source_id: 1, metric_name: metric, numeric_value: value, text_value: textValue,
    observed_at: ts, source_timestamp: null, collection_version: collectionVersion, raw_payload_ref: null, metadata: null,
  });
  const rows: Observation[] = [row("website_fetch_outcome", null, outcome)];
  if (prelaunch !== undefined) rows.push(row("website_homepage_prelaunch", prelaunch));
  for (const [pt, v] of Object.entries(pages)) if (v !== undefined) rows.push(row(`website_page_${pt}`, v, v === 1 ? `/${pt}` : null));
  return rows;
}

// ---- LEVEL: cold-start footprint ------------------------------------------------------------------------------

test("level: minimal first-look site (case A) — no exaggerated signal", () => {
  const history = pass(2, "ok", { pricing: 0, enterprise: 0, security: 0, customers: 0, careers: 0 });
  assert.deepEqual(deriveWebsiteLevelSignals(1, history), []);
});

test("level: mature first-look footprint (case B) fires the combination signal with honest 'present at first observation' wording", () => {
  const history = pass(2, "ok", { pricing: 1, enterprise: 1, security: 1, customers: 1, careers: 1 });
  const signals = deriveWebsiteLevelSignals(1, history);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.signal_type, "website_commercial_footprint_present_at_first_observation");
  assert.equal(signals[0]!.family, "website");
  assert.deepEqual((signals[0]!.metadata as { patterns: string[] }).patterns.sort(), ["enterprise_ready", "proven_commercial"]);
  assert.doesNotMatch(signals[0]!.explanation, /\bappeared\b|\bstarted\b/i, "level signals never claim a change");
});

test("level: only ONE named pattern matching still fires (pricing+customers, no enterprise/security)", () => {
  const history = pass(2, "ok", { pricing: 1, customers: 1, enterprise: 0, security: 0, careers: 0 });
  const signals = deriveWebsiteLevelSignals(1, history);
  assert.equal(signals.length, 1);
  assert.deepEqual((signals[0]!.metadata as { patterns: string[] }).patterns, ["proven_commercial"]);
});

test("level: careers alone (low tier, not part of either named pattern) never fires the footprint signal by itself", () => {
  const history = pass(2, "ok", { careers: 1, pricing: 0, enterprise: 0, security: 0, customers: 0 });
  assert.deepEqual(deriveWebsiteLevelSignals(1, history), []);
});

test("level: fires AT MOST ONCE ever — a second 'ok' pass stops it from being proposed again, even if the second pass is also mature", () => {
  const history = [...pass(48, "ok", { pricing: 1, customers: 1 }), ...pass(2, "ok", { pricing: 1, customers: 1 })];
  assert.deepEqual(deriveWebsiteLevelSignals(1, history), [], "with 2 'ok' passes on record, the cold-start gate no longer applies");
});

test("level: a failed first pass (timeout) does not count as the 'first observation' — the gate waits for the first OK pass", () => {
  const history = [...pass(48, "timeout", {}), ...pass(2, "ok", { pricing: 1, customers: 1 })];
  const signals = deriveWebsiteLevelSignals(1, history);
  assert.equal(signals.length, 1, "the failed pass never counted, so this IS still the (only) ok pass");
});

// ---- TRANSITION: confirmed appearance -------------------------------------------------------------------------

test("transition: absent -> present -> present (case C) fires a confirmed pricing-appeared signal", () => {
  const history = [obs("website_page_pricing", 72, 0), obs("website_page_pricing", 48, 1), obs("website_page_pricing", 2, 1)];
  const signals = deriveWebsiteTransitionSignals(1, history);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.signal_type, "website_pricing_page_appeared");
  assert.equal(signals[0]!.family, "website");
  assert.equal((signals[0]!.metadata as { tier: string }).tier, "high");
});

test("transition: careers appearing is LOW tier but still fires (and is family-eligible)", () => {
  const history = [obs("website_page_careers", 72, 0), obs("website_page_careers", 48, 1), obs("website_page_careers", 2, 1)];
  const signals = deriveWebsiteTransitionSignals(1, history);
  assert.equal(signals[0]!.signal_type, "website_careers_page_appeared");
  assert.equal((signals[0]!.metadata as { tier: string }).tier, "low");
});

test("transition: a SINGLE present reading (never confirmed absent first) never fires — that's the LEVEL signal's job, not a transition", () => {
  const history = [obs("website_page_pricing", 2, 1)];
  assert.deepEqual(deriveWebsiteTransitionSignals(1, history), []);
});

test("transition: only present ONCE (not confirmed twice) never fires — confirmation is required", () => {
  const history = [obs("website_page_pricing", 48, 0), obs("website_page_pricing", 2, 1)];
  assert.deepEqual(deriveWebsiteTransitionSignals(1, history), []);
});

test("transition: an unknown (unwritten) reading between absent and present is correctly ignored, not treated as a gap-breaker", () => {
  // The middle pass never wrote a pricing row at all (unknown) — since sources/website.ts NEVER
  // writes unknown rows, this is exactly what "unknown between known readings" looks like in
  // practice: it's simply absent from the array entirely.
  const history = [obs("website_page_pricing", 72, 0), obs("website_page_pricing", 48, 1), obs("website_page_pricing", 2, 1)];
  const signals = deriveWebsiteTransitionSignals(1, history);
  assert.equal(signals.length, 1, "unknown passes never break the absent->present->present detection since they're simply never written");
});

test("transition: a version bump between the absent baseline and the present readings suppresses the signal (detector change, not a real one)", () => {
  const history = [
    obs("website_page_pricing", 72, 0, { collection_version: "website-v1" }),
    obs("website_page_pricing", 48, 1, { collection_version: "website-v2" }),
    obs("website_page_pricing", 2, 1, { collection_version: "website-v2" }),
  ];
  assert.deepEqual(deriveWebsiteTransitionSignals(1, history), []);
});

test("transition: flapping (present before, absent, present again) never re-fires — first appearance only", () => {
  const history = [
    obs("website_page_pricing", 200, 1), // present from the very start — not a genuine "first appearance"
    obs("website_page_pricing", 150, 0),
    obs("website_page_pricing", 100, 1),
    obs("website_page_pricing", 2, 1),
  ];
  assert.deepEqual(deriveWebsiteTransitionSignals(1, history), [], "the page was present before it ever went absent — this is not a first appearance");
});

test("transition: re-running against the exact same history never produces a duplicate (anchored to fixed observation ids)", () => {
  const history = [obs("website_page_pricing", 72, 0), obs("website_page_pricing", 48, 1), obs("website_page_pricing", 2, 1)];
  const first = deriveWebsiteTransitionSignals(1, history);
  const second = deriveWebsiteTransitionSignals(1, history);
  assert.deepEqual(first, second, "deriving twice from unchanged history produces the identical signal (same anchors) — dedup.ts handles not re-inserting it");
});

test("transition: multiple website page appearances still count as ONE active family (source-richness bias fix)", () => {
  const history = [
    obs("website_page_pricing", 72, 0), obs("website_page_pricing", 48, 1), obs("website_page_pricing", 2, 1),
    obs("website_page_enterprise", 72, 0), obs("website_page_enterprise", 48, 1), obs("website_page_enterprise", 2, 1),
    obs("website_page_customers", 72, 0), obs("website_page_customers", 48, 1), obs("website_page_customers", 2, 1),
  ];
  const signals = deriveWebsiteTransitionSignals(1, history).map((s) => ({ ...s, id: null }) as never);
  assert.equal(signals.length, 3, "three distinct page appearances");
  const activity = summarizeFamilyActivity(signals as never);
  assert.equal(activity.length, 1);
  assert.equal(activity[0]!.family, "website");
  assert.equal(activity[0]!.signalCount, 3);
  const active = activeFamiliesWithinWindow(signals as never, 30, new Date());
  assert.deepEqual(active, ["website"], "3 website signals must count as exactly ONE active family, never three");
});

// ---- prelaunch -> public ---------------------------------------------------------------------------------------

test("prelaunch->public: a genuine waitlist-then-launched sequence fires, confirmed twice", () => {
  const history = [
    ...pass(200, "ok", { pricing: 0, enterprise: 0, security: 0, customers: 0, careers: 0 }, 1),
    ...pass(48, "ok", { pricing: 1, enterprise: 0, security: 0, customers: 0 }, 0),
    ...pass(2, "ok", { pricing: 1, enterprise: 0, security: 0, customers: 0 }, 0),
  ];
  const signals = deriveWebsiteTransitionSignals(1, history);
  const transition = signals.find((s) => s.signal_type === "website_prelaunch_to_public");
  assert.ok(transition, "the prelaunch->public transition should fire");
  assert.doesNotMatch(transition!.explanation, /\bstealth\b/i, "must never claim the company was literally 'in stealth' — only what the website showed");
});

test("prelaunch->public: a SINGLE public reading (not confirmed twice) never fires", () => {
  const history = [...pass(48, "ok", {}, 1), ...pass(2, "ok", { pricing: 1 }, 0)];
  assert.ok(!deriveWebsiteTransitionSignals(1, history).some((s) => s.signal_type === "website_prelaunch_to_public"));
});

test("prelaunch->public: only careers present does not count as 'public' (careers is excluded from the high-tier check)", () => {
  const history = [...pass(96, "ok", {}, 1), ...pass(48, "ok", { careers: 1 }, 0), ...pass(2, "ok", { careers: 1 }, 0)];
  assert.ok(!deriveWebsiteTransitionSignals(1, history).some((s) => s.signal_type === "website_prelaunch_to_public"));
});

test("prelaunch->public: a company that already looked public before ever showing prelaunch markers never fires it", () => {
  const history = [...pass(96, "ok", { pricing: 1 }, 0), ...pass(48, "ok", {}, 1), ...pass(2, "ok", {}, 1)];
  assert.ok(!deriveWebsiteTransitionSignals(1, history).some((s) => s.signal_type === "website_prelaunch_to_public"));
});

// ---- wiring: observe.ts's dispatcher includes both website rule families ------------------------------------------

test("observe.ts: deriveSignalsForCompany includes both website level and transition signals", () => {
  const history = [
    ...pass(2, "ok", { pricing: 1, customers: 1 }), // level: proven_commercial
  ];
  const derived = deriveSignalsForCompany(1, history);
  assert.ok(derived.some((s) => s.signal_type === "website_commercial_footprint_present_at_first_observation"));
});
