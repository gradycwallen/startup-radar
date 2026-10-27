import assert from "node:assert/strict";
import { test } from "node:test";
import { compareMomentumDesc, computeMomentum } from "../src/lib/derive/momentum.ts";
import type { ActivitySignal, CompanyWithEvents, DiscoveryEvent } from "../src/lib/data/types.ts";

/** Pure-function tests for Momentum: distinct signals weighted by recency, never source count. */

const NOW = new Date("2026-10-27T12:00:00Z");
let nextId = 1;

function event(eventDate: string, overrides: Partial<DiscoveryEvent> = {}): DiscoveryEvent {
  return {
    id: nextId++, companyId: 1, eventType: "funding", eventDate, sourceName: `Outlet ${nextId}`, sourceUrl: null,
    headline: "Acme raises $5M", description: null, confidence: 0.9, observedAt: `${eventDate}T09:00:00Z`, ...overrides,
  };
}
function company(events: DiscoveryEvent[], activitySignals: ActivitySignal[] = [], discoveredAt = "2026-10-01T00:00:00Z"): CompanyWithEvents {
  return {
    id: nextId++, name: "Acme", domain: "acme.com", description: null, category: null, discoveredAt, discoverySource: null,
    discoveryUrl: null, confidence: 0.9, discoveryReason: null, foundedYear: null, events, activitySignals,
  };
}

test("many outlets covering one story count as a single signal", () => {
  const syndicated = company(["2026-10-26", "2026-10-26", "2026-10-25", "2026-10-24"].map((d, i) => event(d, { eventType: i % 2 ? "stealth" : "funding" })));
  const m = computeMomentum(syndicated, NOW);
  assert.equal(m.signalCount, 1);
  assert.equal(m.score, computeMomentum(company([event("2026-10-26")]), NOW).score);
});

test("several distinct recent signals outrank one fresher headline", () => {
  const busy = company([event("2026-10-17"), event("2026-10-03", { eventType: "product_launch" })], [{ signalType: "release_activity", firedAt: "2026-10-20T10:00:00Z" }]);
  const oneFresh = company([event("2026-10-27")]);
  assert.equal(computeMomentum(busy, NOW).signalCount, 3);
  assert.ok(compareMomentumDesc(busy, oneFresh, NOW) < 0);
});

test("with equal signal counts, the more recent company ranks first", () => {
  const fresh = company([event("2026-10-26")]);
  const stale = company([event("2026-10-10")]);
  assert.ok(compareMomentumDesc(fresh, stale, NOW) < 0);
});

test("a re-fired change signal counts once per week, and first-look signals never count", () => {
  const daily = ["21", "22", "23", "24", "25", "26", "27"].map((d) => ({ signalType: "release_activity", firedAt: `2026-10-${d}T08:00:00Z` }));
  const firstLook = { signalType: "high_hiring_present_at_first_observation", firedAt: "2026-10-27T08:00:00Z" };
  const m = computeMomentum(company([], [...daily, firstLook]), NOW);
  assert.equal(m.signalCount, 1);
  assert.equal(m.latestAt, new Date("2026-10-27T08:00:00Z").getTime());
});

test("signals older than the window drop out, and no events means no momentum", () => {
  assert.equal(computeMomentum(company([event("2026-06-01")]), NOW).signalCount, 0);
  const empty = computeMomentum(company([]), NOW);
  assert.equal(empty.latestAt, null);
  assert.equal(empty.band, "low");
});

test("bands: one fresh signal is Medium, two recent signals are High", () => {
  assert.equal(computeMomentum(company([event("2026-10-26")]), NOW).band, "medium");
  assert.equal(computeMomentum(company([event("2026-10-26"), event("2026-10-18", { eventType: "product_launch" })]), NOW).band, "high");
  assert.equal(computeMomentum(company([event("2026-09-20")]), NOW).band, "low");
});
