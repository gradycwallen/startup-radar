import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeStaleness, formatStalenessReport, STALENESS_THRESHOLDS } from "../src/analysis/staleness.ts";

const NOW = new Date("2026-11-07T00:00:00Z");

test("a company with zero signals ever is excluded entirely -- this measures decay, not unresolved tracking", () => {
  const report = analyzeStaleness([{ id: 1, name: "NeverObserved" }], [], NOW);
  assert.equal(report.evaluated, 0);
  assert.deepEqual(report.stalled, []);
});

test("buckets by days since the MOST RECENT signal across all families combined, not any single family", () => {
  const report = analyzeStaleness(
    [{ id: 1, name: "Acme" }],
    [
      { companyId: 1, firedAt: "2026-08-01T00:00:00Z" }, // old, github
      { companyId: 1, firedAt: "2026-11-01T00:00:00Z" }, // recent, hiring -- this one should win
    ],
    NOW,
  );
  assert.equal(report.evaluated, 1);
  assert.equal(report.buckets.active, 1, "6 days since the most recent signal is well within the active window");
});

test("bucket boundaries are inclusive at the edges, matching STALENESS_THRESHOLDS exactly", () => {
  const exactlyActive = analyzeStaleness([{ id: 1, name: "A" }], [{ companyId: 1, firedAt: new Date(NOW.getTime() - STALENESS_THRESHOLDS.activeMaxDays * 86_400_000).toISOString() }], NOW);
  assert.equal(exactlyActive.buckets.active, 1);

  const justOverActive = analyzeStaleness([{ id: 1, name: "A" }], [{ companyId: 1, firedAt: new Date(NOW.getTime() - (STALENESS_THRESHOLDS.activeMaxDays + 1) * 86_400_000).toISOString() }], NOW);
  assert.equal(justOverActive.buckets.cooling, 1);

  const justOverCooling = analyzeStaleness([{ id: 1, name: "A" }], [{ companyId: 1, firedAt: new Date(NOW.getTime() - (STALENESS_THRESHOLDS.coolingMaxDays + 1) * 86_400_000).toISOString() }], NOW);
  assert.equal(justOverCooling.buckets.stalled, 1);
});

test("the stalled list is sorted longest-silent first", () => {
  const report = analyzeStaleness(
    [{ id: 1, name: "LessStale" }, { id: 2, name: "MoreStale" }],
    [
      { companyId: 1, firedAt: new Date(NOW.getTime() - 50 * 86_400_000).toISOString() },
      { companyId: 2, firedAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString() },
    ],
    NOW,
  );
  assert.deepEqual(report.stalled.map((s) => s.companyName), ["MoreStale", "LessStale"]);
});

test("a company id with no matching name falls back to a safe '#id' label rather than crashing or showing 'undefined'", () => {
  const report = analyzeStaleness([], [{ companyId: 999, firedAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString() }], NOW);
  assert.equal(report.stalled[0]!.companyName, "#999");
});

test("formatStalenessReport explicitly distinguishes 'no signals exist at all' from 'signals exist but none stalled'", () => {
  const noSignalsAtAll = formatStalenessReport(analyzeStaleness([{ id: 1, name: "A" }], [], NOW));
  assert.match(noSignalsAtAll, /nothing to measure decay against/);

  const allActive = formatStalenessReport(analyzeStaleness([{ id: 1, name: "A" }], [{ companyId: 1, firedAt: NOW.toISOString() }], NOW));
  assert.match(allActive, /No stalled companies right now/);
});
